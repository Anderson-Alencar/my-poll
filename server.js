const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');

// Initialize Express and HTTP server
const app = express();
const server = http.createServer(app);

// Initialize Socket.IO with CORS enabled
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  }
});

// Middleware configuration
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// In-Memory Data Storage
// ==========================================

// pollId -> poll object
const polls = new Map();

// code -> pollId
const accessCodes = new Map();

// pollId -> Set of socket.ids
const participantCounts = new Map();

// questionId -> { timer, pollId, question }
const pendingVoteUpdates = new Map();

// ==========================================
// Helper Functions
// ==========================================

/**
 * Generate a unique 6-character uppercase alphanumeric code.
 * @returns {string} 6-character access code
 */
function generateCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (accessCodes.has(code));
  return code;
}

/**
 * Normaliza o peso para números inteiros válidos: 1, 2, 3, 4... consecutivamente.
 * @param {*} val
 * @returns {number} Inteiro >= 1
 */
function normalizeWeight(val) {
  const num = Math.round(Number(val));
  return (!isNaN(num) && num >= 1) ? num : 1;
}

/**
 * Serialize a poll object to JSON-safe structure (converts Maps and excludes votes).
 * @param {Object} poll
 * @returns {Object} JSON-safe poll
 */
function serializePoll(poll) {
  return {
    id: poll.id,
    title: poll.title,
    description: poll.description,
    code: poll.code,
    hasProfiles: poll.hasProfiles,
    status: poll.status,
    currentQuestionId: poll.currentQuestionId,
    createdAt: poll.createdAt,
    profiles: Array.isArray(poll.profiles)
      ? poll.profiles.map(p => ({
          id: p.id,
          name: p.name,
          weight: normalizeWeight(p.weight)
        }))
      : [],
    questions: Array.isArray(poll.questions)
      ? poll.questions.map(q => serializeQuestion(q))
      : []
  };
}

/**
 * Serialize a question object to JSON-safe structure (excludes votes).
 * @param {Object} question
 * @returns {Object} JSON-safe question
 */
function serializeQuestion(question) {
  return {
    id: question.id,
    text: question.text,
    orderNum: question.orderNum,
    votingOpen: question.votingOpen,
    options: Array.isArray(question.options)
      ? question.options.map(opt => ({
          id: opt.id,
          text: opt.text,
          orderNum: opt.orderNum,
          weights: opt.weights || {}
        }))
      : []
  };
}

/**
 * Calculate rawVotes, weightedVotes, and percentage per option for a question.
 * @param {Object} question
 * @returns {Object} Calculated results
 */
function calculateResults(question) {
  const rawCounts = new Map();
  const weightedCounts = new Map();

  if (Array.isArray(question.options)) {
    question.options.forEach(opt => {
      rawCounts.set(opt.id, 0);
      weightedCounts.set(opt.id, 0);
    });
  }

  let totalRawVotes = 0;
  let totalWeightedVotes = 0;

  if (question.votes instanceof Map) {
    for (const vote of question.votes.values()) {
      if (rawCounts.has(vote.optionId)) {
        const raw = rawCounts.get(vote.optionId);
        const weighted = weightedCounts.get(vote.optionId);
        const weight = normalizeWeight(vote.weight);

        rawCounts.set(vote.optionId, raw + 1);
        weightedCounts.set(vote.optionId, weighted + weight);
        totalRawVotes += 1;
        totalWeightedVotes += weight;
      }
    }
  }

  // Round totalWeightedVotes to 3 decimals to avoid floating point anomalies
  totalWeightedVotes = Math.round(totalWeightedVotes * 1000) / 1000;

  const options = (question.options || []).map(opt => {
    const rawVotes = rawCounts.get(opt.id) || 0;
    const rawWeighted = weightedCounts.get(opt.id) || 0;
    const weightedVotes = Math.round(rawWeighted * 1000) / 1000;

    let percentage = 0;
    if (totalWeightedVotes > 0) {
      percentage = Math.round(((weightedVotes / totalWeightedVotes) * 100) * 10) / 10;
    }

    return {
      id: opt.id,
      text: opt.text,
      rawVotes,
      weightedVotes,
      percentage
    };
  });

  return {
    id: question.id,
    questionId: question.id,
    text: question.text,
    totalRawVotes,
    totalWeightedVotes,
    options
  };
}

/**
 * Search all polls to find the poll containing a given question ID.
 * @param {string} questionId
 * @returns {{ poll: Object, question: Object } | null}
 */
function findPollByQuestionId(questionId) {
  for (const poll of polls.values()) {
    if (Array.isArray(poll.questions)) {
      const question = poll.questions.find(q => q.id === questionId);
      if (question) {
        return { poll, question };
      }
    }
  }
  return null;
}

/**
 * Debounce vote updates per question every 100ms.
 * @param {string} pollId
 * @param {Object} question
 */
function debounceVoteUpdate(pollId, question) {
  if (pendingVoteUpdates.has(question.id)) {
    return;
  }

  const timer = setTimeout(() => {
    pendingVoteUpdates.delete(question.id);

    const poll = polls.get(pollId);
    if (!poll) return;

    const currentQuestion = poll.questions.find(q => q.id === question.id);
    if (!currentQuestion) return;

    const results = calculateResults(currentQuestion);
    io.to(`poll:${pollId}`).emit('vote-updated', {
      questionId: currentQuestion.id,
      results
    });
  }, 100);

  pendingVoteUpdates.set(question.id, { timer, pollId, question });
}

// ==========================================
// REST API Endpoints
// ==========================================

// 1. POST /api/polls - Create poll
app.post('/api/polls', (req, res) => {
  try {
    const { title, description = '', hasProfiles = false, profiles = [], creatorId = null, creatorEmail = null, id: customId = null, code: customCode = null } = req.body;

    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'Título é obrigatório' });
    }

    const code = (customCode && typeof customCode === 'string' && customCode.trim()) ? customCode.trim().toUpperCase() : generateCode();
    const pollId = customId || uuidv4();

    const formattedProfiles = (Boolean(hasProfiles) && Array.isArray(profiles))
      ? profiles.map(p => ({
          id: p.id || uuidv4(),
          name: String(p.name || '').trim(),
          weight: normalizeWeight(p.weight)
        }))
      : [];

    const poll = {
      id: pollId,
      title: title.trim(),
      description: String(description || '').trim(),
      code,
      hasProfiles: Boolean(hasProfiles),
      status: 'draft',
      currentQuestionId: null,
      creatorId: creatorId || null,
      creatorEmail: creatorEmail || null,
      createdAt: req.body.createdAt || new Date().toISOString(),
      profiles: formattedProfiles,
      questions: []
    };

    polls.set(poll.id, poll);
    accessCodes.set(poll.code, poll.id);

    return res.status(201).json(serializePoll(poll));
  } catch (err) {
    console.error('Error creating poll:', err);
    return res.status(500).json({ error: 'Erro ao criar enquete' });
  }
});

// 1.1 POST /api/polls/sync - Synchronize poll from Firestore to active memory
app.post('/api/polls/sync', (req, res) => {
  try {
    const pollData = req.body;
    if (!pollData || !pollData.id || !pollData.code) {
      return res.status(400).json({ error: 'Dados da enquete inválidos para sincronização' });
    }

    let existingPoll = polls.get(pollData.id);
    if (!existingPoll) {
      existingPoll = {
        id: pollData.id,
        title: String(pollData.title || '').trim(),
        description: String(pollData.description || '').trim(),
        code: String(pollData.code).trim().toUpperCase(),
        hasProfiles: Boolean(pollData.hasProfiles),
        status: pollData.status || 'draft',
        currentQuestionId: pollData.currentQuestionId || null,
        creatorId: pollData.creatorId || null,
        creatorEmail: pollData.creatorEmail || null,
        createdAt: pollData.createdAt || new Date().toISOString(),
        profiles: Array.isArray(pollData.profiles) ? pollData.profiles.map(p => ({
          id: p.id || uuidv4(),
          name: String(p.name || '').trim(),
          weight: normalizeWeight(p.weight)
        })) : [],
        questions: []
      };
      polls.set(existingPoll.id, existingPoll);
      accessCodes.set(existingPoll.code, existingPoll.id);
    } else {
      existingPoll.title = String(pollData.title || existingPoll.title).trim();
      existingPoll.description = String(pollData.description || existingPoll.description).trim();
      existingPoll.hasProfiles = Boolean(pollData.hasProfiles);
      if (pollData.creatorId) existingPoll.creatorId = pollData.creatorId;
      if (pollData.creatorEmail) existingPoll.creatorEmail = pollData.creatorEmail;
    }

    if (Array.isArray(pollData.questions)) {
      existingPoll.questions = pollData.questions.map((q, idx) => {
        const existingQ = (existingPoll.questions || []).find(eq => eq.id === q.id);
        const votesMap = (existingQ && existingQ.votes instanceof Map) ? existingQ.votes : new Map();

        return {
          id: q.id || uuidv4(),
          text: String(q.text || '').trim(),
          orderNum: q.orderNum || idx + 1,
          votingOpen: Boolean(q.votingOpen),
          options: Array.isArray(q.options) ? q.options.map((opt, oIdx) => ({
            id: opt.id || uuidv4(),
            text: String(opt.text || '').trim(),
            orderNum: opt.orderNum || oIdx + 1,
            weights: opt.weights || {}
          })) : [],
          votes: votesMap
        };
      });
    }

    return res.json({ success: true, poll: serializePoll(existingPoll) });
  } catch (err) {
    console.error('Error syncing poll:', err);
    return res.status(500).json({ error: 'Erro ao sincronizar enquete' });
  }
});

// 2. GET /api/polls - List all polls
app.get('/api/polls', (req, res) => {
  try {
    const list = Array.from(polls.values()).map(poll => ({
      id: poll.id,
      title: poll.title,
      code: poll.code,
      status: poll.status,
      hasProfiles: poll.hasProfiles,
      createdAt: poll.createdAt,
      questionCount: Array.isArray(poll.questions) ? poll.questions.length : 0
    }));

    return res.json(list);
  } catch (err) {
    console.error('Error listing polls:', err);
    return res.status(500).json({ error: 'Erro ao listar enquetes' });
  }
});

// 3. GET /api/polls/:id - Get poll with questions and options
app.get('/api/polls/:id', (req, res) => {
  try {
    const poll = polls.get(req.params.id);
    if (!poll) {
      return res.status(404).json({ error: 'Enquete não encontrada' });
    }

    return res.json(serializePoll(poll));
  } catch (err) {
    console.error('Error fetching poll:', err);
    return res.status(500).json({ error: 'Erro ao buscar enquete' });
  }
});

// 4. PUT /api/polls/:id - Update poll
app.put('/api/polls/:id', (req, res) => {
  try {
    const poll = polls.get(req.params.id);
    if (!poll) {
      return res.status(404).json({ error: 'Enquete não encontrada' });
    }

    const { title, description, status } = req.body;

    if (title !== undefined) {
      if (typeof title !== 'string' || !title.trim()) {
        return res.status(400).json({ error: 'Título não pode ser vazio' });
      }
      poll.title = title.trim();
    }

    if (description !== undefined) {
      poll.description = String(description).trim();
    }

    if (status !== undefined) {
      if (!['draft', 'active', 'finished'].includes(status)) {
        return res.status(400).json({ error: 'Status inválido. Use draft, active ou finished' });
      }
      poll.status = status;

      if (status === 'active') {
        if (!poll.currentQuestionId && poll.questions && poll.questions.length > 0) {
          poll.currentQuestionId = poll.questions[0].id;
        }
        poll.questions.forEach(q => { q.votingOpen = false; });
        const activeQ = poll.questions.find(q => q.id === poll.currentQuestionId) || (poll.questions.length > 0 ? poll.questions[0] : null);
        if (activeQ) {
          activeQ.votingOpen = true;
        }
        io.to(`poll:${poll.id}`).emit('poll-started', {
          pollId: poll.id,
          question: activeQ ? serializeQuestion(activeQ) : null
        });
        if (activeQ) {
          io.to(`poll:${poll.id}`).emit('voting-opened', { questionId: activeQ.id });
        }
      } else if (status === 'finished') {
        poll.questions.forEach(q => { q.votingOpen = false; });
        io.to(`poll:${poll.id}`).emit('poll-finished', { pollId: poll.id });
      }
    }

    if (req.body.hasProfiles !== undefined) {
      poll.hasProfiles = Boolean(req.body.hasProfiles);
    }

    if (Array.isArray(req.body.profiles)) {
      poll.profiles = req.body.profiles.map(p => ({
        id: p.id || uuidv4(),
        name: String(p.name || '').trim(),
        weight: normalizeWeight(p.weight)
      }));
    }

    return res.json(serializePoll(poll));
  } catch (err) {
    console.error('Error updating poll:', err);
    return res.status(500).json({ error: 'Erro ao atualizar enquete' });
  }
});

// 5. DELETE /api/polls/:id - Delete poll
app.delete('/api/polls/:id', (req, res) => {
  try {
    const poll = polls.get(req.params.id);
    if (!poll) {
      return res.status(404).json({ error: 'Enquete não encontrada' });
    }

    accessCodes.delete(poll.code);
    polls.delete(poll.id);
    participantCounts.delete(poll.id);

    return res.json({ success: true });
  } catch (err) {
    console.error('Error deleting poll:', err);
    return res.status(500).json({ error: 'Erro ao excluir enquete' });
  }
});

// 6. POST /api/polls/:id/questions - Add question
app.post('/api/polls/:id/questions', (req, res) => {
  try {
    const poll = polls.get(req.params.id);
    if (!poll) {
      return res.status(404).json({ error: 'Enquete não encontrada' });
    }

    const { text, options } = req.body;
    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'Texto da pergunta é obrigatório' });
    }

    const orderNum = poll.questions.length + 1;
    const formattedOptions = Array.isArray(options)
      ? options.map((opt, index) => {
          const rawWeights = (opt && typeof opt.weights === 'object' && opt.weights !== null) ? opt.weights : {};
          const cleanWeights = {};
          for (const [profId, wVal] of Object.entries(rawWeights)) {
            cleanWeights[profId] = normalizeWeight(wVal);
          }

          return {
            id: uuidv4(),
            text: String(opt.text || '').trim(),
            orderNum: index + 1,
            weights: cleanWeights
          };
        })
      : [];

    const question = {
      id: uuidv4(),
      text: text.trim(),
      orderNum,
      votingOpen: false,
      options: formattedOptions,
      votes: new Map()
    };

    poll.questions.push(question);

    return res.status(201).json(serializeQuestion(question));
  } catch (err) {
    console.error('Error adding question:', err);
    return res.status(500).json({ error: 'Erro ao adicionar pergunta' });
  }
});

// 7. PUT /api/questions/:questionId - Update question
app.put('/api/questions/:questionId', (req, res) => {
  try {
    const match = findPollByQuestionId(req.params.questionId);
    if (!match) {
      return res.status(404).json({ error: 'Pergunta não encontrada' });
    }

    const { question } = match;
    const { text, options } = req.body;

    if (text !== undefined) {
      if (typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'Texto da pergunta não pode ser vazio' });
      }
      question.text = text.trim();
    }

    if (Array.isArray(options)) {
      const existingOptionsMap = new Map(question.options.map(o => [o.id, o]));
      const updatedOptions = [];

      options.forEach((opt, index) => {
        const rawWeights = (opt && typeof opt.weights === 'object' && opt.weights !== null) ? opt.weights : {};
        const cleanWeights = {};
        for (const [profId, wVal] of Object.entries(rawWeights)) {
          cleanWeights[profId] = normalizeWeight(wVal);
        }

        if (opt.id && existingOptionsMap.has(opt.id)) {
          const existing = existingOptionsMap.get(opt.id);
          existing.text = String(opt.text !== undefined ? opt.text : existing.text).trim();
          existing.orderNum = index + 1;
          existing.weights = cleanWeights;
          updatedOptions.push(existing);
        } else {
          updatedOptions.push({
            id: uuidv4(),
            text: String(opt.text || '').trim(),
            orderNum: index + 1,
            weights: cleanWeights
          });
        }
      });

      question.options = updatedOptions;

      // Clean up votes for removed options
      const validOptionIds = new Set(updatedOptions.map(o => o.id));
      for (const [participantId, vote] of question.votes.entries()) {
        if (!validOptionIds.has(vote.optionId)) {
          question.votes.delete(participantId);
        }
      }
    }

    if (req.body.votingOpen !== undefined) {
      question.votingOpen = Boolean(req.body.votingOpen);
      if (question.votingOpen) {
        io.to(`poll:${match.poll.id}`).emit('voting-opened', { questionId: question.id });
      } else {
        io.to(`poll:${match.poll.id}`).emit('voting-closed', { questionId: question.id });
      }
    }

    return res.json(serializeQuestion(question));
  } catch (err) {
    console.error('Error updating question:', err);
    return res.status(500).json({ error: 'Erro ao atualizar pergunta' });
  }
});

// 8. DELETE /api/questions/:questionId - Delete question
app.delete('/api/questions/:questionId', (req, res) => {
  try {
    const match = findPollByQuestionId(req.params.questionId);
    if (!match) {
      return res.status(404).json({ error: 'Pergunta não encontrada' });
    }

    const { poll } = match;
    poll.questions = poll.questions.filter(q => q.id !== req.params.questionId);

    // Reorder remaining questions
    poll.questions.forEach((q, index) => {
      q.orderNum = index + 1;
    });

    // Update currentQuestionId if active question was deleted
    if (poll.currentQuestionId === req.params.questionId) {
      poll.currentQuestionId = poll.questions.length > 0 ? poll.questions[0].id : null;
    }

    // Clear any pending debounced update for this question
    if (pendingVoteUpdates.has(req.params.questionId)) {
      clearTimeout(pendingVoteUpdates.get(req.params.questionId).timer);
      pendingVoteUpdates.delete(req.params.questionId);
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('Error deleting question:', err);
    return res.status(500).json({ error: 'Erro ao excluir pergunta' });
  }
});

// 9. GET /api/polls/:id/results - Get all results
app.get('/api/polls/:id/results', (req, res) => {
  try {
    const poll = polls.get(req.params.id);
    if (!poll) {
      return res.status(404).json({ error: 'Enquete não encontrada' });
    }

    const questionsResults = poll.questions.map(q => {
      const calculated = calculateResults(q);
      return {
        id: q.id,
        text: q.text,
        totalRawVotes: calculated.totalRawVotes,
        totalWeightedVotes: calculated.totalWeightedVotes,
        options: calculated.options
      };
    });

    return res.json({
      pollId: poll.id,
      title: poll.title,
      hasProfiles: poll.hasProfiles,
      questions: questionsResults
    });
  } catch (err) {
    console.error('Error fetching poll results:', err);
    return res.status(500).json({ error: 'Erro ao buscar resultados da enquete' });
  }
});

// 10. GET /api/polls/:id/results/:questionId - Get results for specific question
app.get('/api/polls/:id/results/:questionId', (req, res) => {
  try {
    const poll = polls.get(req.params.id);
    if (!poll) {
      return res.status(404).json({ error: 'Enquete não encontrada' });
    }

    const question = poll.questions.find(q => q.id === req.params.questionId);
    if (!question) {
      return res.status(404).json({ error: 'Pergunta não encontrada' });
    }

    const calculated = calculateResults(question);

    return res.json({
      questionId: question.id,
      text: question.text,
      totalRawVotes: calculated.totalRawVotes,
      totalWeightedVotes: calculated.totalWeightedVotes,
      options: calculated.options
    });
  } catch (err) {
    console.error('Error fetching question results:', err);
    return res.status(500).json({ error: 'Erro ao buscar resultados da pergunta' });
  }
});

// 11. GET /api/polls/join/:code - Find poll by access code
app.get('/api/polls/join/:code', (req, res) => {
  try {
    const code = String(req.params.code || '').trim().toUpperCase();
    const pollId = accessCodes.get(code);

    if (!pollId) {
      return res.status(404).json({ error: 'Código de enquete não encontrado' });
    }

    const poll = polls.get(pollId);
    if (!poll) {
      return res.status(404).json({ error: 'Enquete não encontrada' });
    }

    let currentQuestion = null;
    if (poll.status === 'active') {
      if (!poll.currentQuestionId && poll.questions && poll.questions.length > 0) {
        poll.currentQuestionId = poll.questions[0].id;
      }
      if (poll.currentQuestionId) {
        const q = poll.questions.find(item => item.id === poll.currentQuestionId);
        if (q) {
          q.votingOpen = true;
          currentQuestion = {
            id: q.id,
            text: q.text,
            votingOpen: true,
            options: q.options.map(opt => ({
              id: opt.id,
              text: opt.text
            }))
          };
        }
      }
    }

    // Return poll info with profiles WITHOUT weights
    return res.json({
      id: poll.id,
      title: poll.title,
      description: poll.description,
      hasProfiles: poll.hasProfiles,
      profiles: (poll.profiles || []).map(p => ({
        id: p.id,
        name: p.name
      })),
      status: poll.status,
      currentQuestion
    });
  } catch (err) {
    console.error('Error joining poll by code:', err);
    return res.status(500).json({ error: 'Erro ao buscar enquete pelo código' });
  }
});

// 12. GET /api/polls/:id/qrcode - Get QR code
app.get('/api/polls/:id/qrcode', async (req, res) => {
  try {
    const poll = polls.get(req.params.id);
    if (!poll) {
      return res.status(404).json({ error: 'Enquete não encontrada' });
    }

    const forwardedProto = req.headers['x-forwarded-proto'];
    const protocol = forwardedProto ? forwardedProto.split(',')[0].trim() : req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const qrContent = `${protocol}://${host}/vote.html#${poll.code}`;

    const dataUrl = await QRCode.toDataURL(qrContent, {
      margin: 2,
      scale: 8,
      color: {
        dark: '#0f172a',
        light: '#ffffff'
      }
    });

    return res.json({ dataUrl, url: qrContent });
  } catch (err) {
    console.error('Error generating QR code:', err);
    return res.status(500).json({ error: 'Erro ao gerar QR Code' });
  }
});

// Helper to register vote (shared by Socket.IO and HTTP fallback)
function registerVote({ pollId, questionId, optionId, participantId, profileId }) {
  if (!pollId || !questionId || !optionId || !participantId) {
    return { success: false, error: 'Dados do voto incompletos' };
  }

  const poll = polls.get(pollId);
  if (!poll) {
    return { success: false, error: 'Enquete não encontrada no servidor' };
  }

  const question = poll.questions.find(q => q.id === questionId);
  if (!question) {
    return { success: false, error: 'Pergunta não encontrada' };
  }

  if (!question.votingOpen) {
    return { success: false, error: 'Votação fechada para esta pergunta' };
  }

  // Regra: Uma vez confirmado o voto pelo participante, o voto não poderá ser alterado
  if (question.votes.has(participantId)) {
    return { success: false, error: 'Seu voto já foi confirmado e não pode ser alterado.' };
  }

  const option = question.options.find(o => o.id === optionId);
  if (!option) {
    return { success: false, error: 'Opção de voto inválida' };
  }

  let weight = 1;
  let validProfileId = null;

  if (poll.hasProfiles && profileId) {
    const profile = poll.profiles.find(p => p.id === profileId);
    if (profile) {
      validProfileId = profile.id;
      if (option.weights && option.weights[profile.id] !== undefined) {
        weight = normalizeWeight(option.weights[profile.id]);
      } else if (profile.weight !== undefined) {
        weight = normalizeWeight(profile.weight);
      }
    }
  }

  question.votes.set(participantId, {
    optionId,
    profileId: validProfileId,
    weight,
    createdAt: new Date().toISOString()
  });

  // Debounce emission of vote-updated event to WebSocket listeners
  debounceVoteUpdate(pollId, question);

  return { success: true };
}

// 13. POST /api/polls/:id/vote - HTTP vote endpoint for serverless environments (Vercel)
app.post('/api/polls/:id/vote', (req, res) => {
  try {
    const pollId = req.params.id;
    const { questionId, optionId, participantId, profileId } = req.body || {};
    const result = registerVote({ pollId, questionId, optionId, participantId, profileId });
    if (!result.success) {
      return res.status(400).json(result);
    }
    return res.json(result);
  } catch (err) {
    console.error('Error handling HTTP vote:', err);
    return res.status(500).json({ success: false, error: 'Erro interno ao registrar voto' });
  }
});

// 14. PUT /api/polls/:id/status - Update poll status directly
app.put('/api/polls/:id/status', (req, res) => {
  try {
    const poll = polls.get(req.params.id);
    if (!poll) {
      return res.status(404).json({ error: 'Enquete não encontrada' });
    }
    const { status } = req.body || {};
    if (!['draft', 'active', 'finished'].includes(status)) {
      return res.status(400).json({ error: 'Status inválido. Use draft, active ou finished' });
    }
    poll.status = status;
    if (status === 'active') {
      if (!poll.currentQuestionId && poll.questions.length > 0) {
        poll.currentQuestionId = poll.questions[0].id;
      }
      poll.questions.forEach(q => { q.votingOpen = false; });
      const activeQ = poll.questions.find(q => q.id === poll.currentQuestionId);
      if (activeQ) {
        activeQ.votingOpen = true;
      }
      io.to(`poll:${poll.id}`).emit('poll-started', {
        pollId: poll.id,
        question: activeQ ? serializeQuestion(activeQ) : null
      });
      if (activeQ) {
        io.to(`poll:${poll.id}`).emit('voting-opened', { questionId: activeQ.id });
      }
    } else if (status === 'finished') {
      poll.questions.forEach(q => { q.votingOpen = false; });
      io.to(`poll:${poll.id}`).emit('poll-finished', { pollId: poll.id });
    }
    return res.json(serializePoll(poll));
  } catch (err) {
    console.error('Error updating poll status:', err);
    return res.status(500).json({ error: 'Erro ao atualizar status da enquete' });
  }
});

// 15. PUT /api/polls/:id/current-question - Change active question
app.put('/api/polls/:id/current-question', (req, res) => {
  try {
    const poll = polls.get(req.params.id);
    if (!poll) {
      return res.status(404).json({ error: 'Enquete não encontrada' });
    }
    const { questionId } = req.body || {};
    if (!questionId) {
      return res.status(400).json({ error: 'ID da pergunta é obrigatório' });
    }

    const question = poll.questions.find(q => q.id === questionId);
    if (!question) {
      return res.status(404).json({ error: 'Pergunta não encontrada' });
    }

    poll.questions.forEach(q => { q.votingOpen = false; });
    poll.currentQuestionId = questionId;
    question.votingOpen = true;

    io.to(`poll:${poll.id}`).emit('question-changed', {
      question: serializeQuestion(question)
    });
    io.to(`poll:${poll.id}`).emit('voting-opened', { questionId });

    return res.json({ success: true, currentQuestion: serializeQuestion(question) });
  } catch (err) {
    console.error('Error changing current question:', err);
    return res.status(500).json({ error: 'Erro ao alterar pergunta ativa' });
  }
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err);
  return res.status(500).json({ error: 'Erro interno do servidor' });
});

// ==========================================
// Socket.IO Real-Time Events
// ==========================================

io.on('connection', socket => {
  // join-poll: { pollId, role: 'presenter' | 'participant' }
  socket.on('join-poll', data => {
    try {
      const { pollId, role = 'participant' } = data || {};
      if (!pollId) {
        return socket.emit('error', { message: 'ID da enquete é obrigatório' });
      }

      // If socket was already participating in a poll, cleanup previous registration
      if (socket.pollId && socket.role === 'participant' && participantCounts.has(socket.pollId)) {
        const prevParticipants = participantCounts.get(socket.pollId);
        prevParticipants.delete(socket.id);
        io.to(`poll:${socket.pollId}`).emit('participant-count', { count: prevParticipants.size });
        socket.leave(`poll:${socket.pollId}`);
      }

      socket.pollId = pollId;
      socket.role = role;
      socket.join(`poll:${pollId}`);

      if (role === 'participant') {
        if (!participantCounts.has(pollId)) {
          participantCounts.set(pollId, new Set());
        }
        participantCounts.get(pollId).add(socket.id);
      }

      const count = participantCounts.has(pollId) ? participantCounts.get(pollId).size : 0;
      io.to(`poll:${pollId}`).emit('participant-count', { count });

      // Emit current poll state to the newly joined socket so it never stays stuck
      const currentPollObj = polls.get(pollId);
      if (currentPollObj) {
        if (currentPollObj.status === 'active' && !currentPollObj.currentQuestionId && currentPollObj.questions && currentPollObj.questions.length > 0) {
          currentPollObj.currentQuestionId = currentPollObj.questions[0].id;
        }
        const activeQ = (currentPollObj.status === 'active' && currentPollObj.currentQuestionId)
          ? currentPollObj.questions.find(q => q.id === currentPollObj.currentQuestionId)
          : null;

        socket.emit('poll-state', {
          pollId: currentPollObj.id,
          status: currentPollObj.status,
          currentQuestion: activeQ ? serializeQuestion(activeQ) : null
        });
      }
    } catch (err) {
      console.error('Error in join-poll:', err);
      socket.emit('error', { message: 'Erro ao ingressar na enquete' });
    }
  });

  // cast-vote: { pollId, questionId, optionId, participantId, profileId? } with ack callback
  socket.on('cast-vote', (data, callback) => {
    try {
      const result = registerVote(data || {});
      if (typeof callback === 'function') {
        callback(result);
      }
    } catch (err) {
      console.error('Error handling cast-vote:', err);
      if (typeof callback === 'function') {
        callback({ success: false, error: 'Erro interno ao registrar voto' });
      }
    }
  });

  // change-question: { pollId, questionId }
  socket.on('change-question', data => {
    try {
      const { pollId, questionId } = data || {};
      const poll = polls.get(pollId);
      if (!poll) {
        return socket.emit('error', { message: 'Enquete não encontrada' });
      }

      const question = poll.questions.find(q => q.id === questionId);
      if (!question) {
        return socket.emit('error', { message: 'Pergunta não encontrada' });
      }

      poll.questions.forEach(q => { q.votingOpen = false; });
      poll.currentQuestionId = questionId;
      question.votingOpen = true;

      io.to(`poll:${pollId}`).emit('question-changed', {
        question: serializeQuestion(question)
      });
      io.to(`poll:${pollId}`).emit('voting-opened', { questionId });
    } catch (err) {
      console.error('Error in change-question:', err);
      socket.emit('error', { message: 'Erro ao alterar pergunta ativa' });
    }
  });

  // open-voting: { pollId, questionId }
  socket.on('open-voting', data => {
    try {
      const { pollId, questionId } = data || {};
      const poll = polls.get(pollId);
      if (!poll) {
        return socket.emit('error', { message: 'Enquete não encontrada' });
      }

      const question = poll.questions.find(q => q.id === questionId);
      if (!question) {
        return socket.emit('error', { message: 'Pergunta não encontrada' });
      }

      question.votingOpen = true;
      io.to(`poll:${pollId}`).emit('voting-opened', { questionId });
    } catch (err) {
      console.error('Error in open-voting:', err);
      socket.emit('error', { message: 'Erro ao abrir votação' });
    }
  });

  // close-voting: { pollId, questionId }
  socket.on('close-voting', data => {
    try {
      const { pollId, questionId } = data || {};
      const poll = polls.get(pollId);
      if (!poll) {
        return socket.emit('error', { message: 'Enquete não encontrada' });
      }

      const question = poll.questions.find(q => q.id === questionId);
      if (!question) {
        return socket.emit('error', { message: 'Pergunta não encontrada' });
      }

      question.votingOpen = false;

      // Flush any pending vote update immediately
      if (pendingVoteUpdates.has(questionId)) {
        const pending = pendingVoteUpdates.get(questionId);
        clearTimeout(pending.timer);
        pendingVoteUpdates.delete(questionId);

        const results = calculateResults(question);
        io.to(`poll:${pollId}`).emit('vote-updated', { questionId, results });
      }

      io.to(`poll:${pollId}`).emit('voting-closed', { questionId });
    } catch (err) {
      console.error('Error in close-voting:', err);
      socket.emit('error', { message: 'Erro ao fechar votação' });
    }
  });

  // start-poll: { pollId }
  socket.on('start-poll', data => {
    try {
      const { pollId } = data || {};
      const poll = polls.get(pollId);
      if (!poll) {
        return socket.emit('error', { message: 'Enquete não encontrada' });
      }

      poll.status = 'active';

      let question = null;
      if (poll.questions && poll.questions.length > 0) {
        if (!poll.currentQuestionId) {
          poll.currentQuestionId = poll.questions[0].id;
        }
        poll.questions.forEach(q => { q.votingOpen = false; });
        const activeQ = poll.questions.find(q => q.id === poll.currentQuestionId) || poll.questions[0];
        poll.currentQuestionId = activeQ.id;
        activeQ.votingOpen = true;
        question = serializeQuestion(activeQ);
      } else {
        poll.currentQuestionId = null;
      }

      io.to(`poll:${pollId}`).emit('poll-started', { pollId, question });
      if (poll.currentQuestionId) {
        io.to(`poll:${pollId}`).emit('voting-opened', { questionId: poll.currentQuestionId });
      }
    } catch (err) {
      console.error('Error in start-poll:', err);
      socket.emit('error', { message: 'Erro ao iniciar enquete' });
    }
  });

  // finish-poll: { pollId }
  socket.on('finish-poll', data => {
    try {
      const { pollId } = data || {};
      const poll = polls.get(pollId);
      if (!poll) {
        return socket.emit('error', { message: 'Enquete não encontrada' });
      }

      poll.status = 'finished';

      // Fechar votação em qualquer pergunta pendente
      poll.questions.forEach(q => {
        q.votingOpen = false;
      });

      io.to(`poll:${pollId}`).emit('poll-finished', { pollId });
    } catch (err) {
      console.error('Error in finish-poll:', err);
      socket.emit('error', { message: 'Erro ao finalizar enquete' });
    }
  });

  // disconnect: Clean up participant count
  socket.on('disconnect', () => {
    try {
      const { pollId, role } = socket;
      if (role === 'participant' && pollId && participantCounts.has(pollId)) {
        const participants = participantCounts.get(pollId);
        participants.delete(socket.id);
        const count = participants.size;

        io.to(`poll:${pollId}`).emit('participant-count', { count });

        if (participants.size === 0) {
          participantCounts.delete(pollId);
        }
      }
    } catch (err) {
      console.error('Error handling disconnect:', err);
    }
  });
});

// ==========================================
// Start Server
// ==========================================

const PORT = process.env.APP_PORT || process.env.PORT || 3000;

// Only listen when running standalone (node server.js), not when required by api/index.js or in serverless (e.g. Vercel)
if (require.main === module && !process.env.VERCEL) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor rodando em http://0.0.0.0:${PORT}`);
  });
}

// Export Express app directly as the root export for Vercel Serverless Function compatibility
module.exports = app;

// Attach helper references and server components to app for testing or modular usage
Object.assign(app, {
  server,
  io,
  polls,
  accessCodes,
  participantCounts,
  generateCode,
  normalizeWeight,
  serializePoll,
  serializeQuestion,
  calculateResults,
  findPollByQuestionId,
  registerVote
});

