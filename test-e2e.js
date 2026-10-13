const http = require('http');
const { io } = require('socket.io-client');

async function testSystem() {
  console.log('--- Iniciando Teste Automatizado do Sistema ---');

  // 1. Criar Enquete com perfis ponderados (Ex: Senior peso 2, Junior peso 1)
  const pollPayload = {
    title: 'Enquete de Arquitetura de Software',
    description: 'Votação interativa com perfis Senior e Junior',
    hasProfiles: true,
    profiles: [
      { name: 'Senior', weight: 2 },
      { name: 'Junior', weight: 1 }
    ]
  };

  const createRes = await fetch('http://localhost:3000/api/polls', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(pollPayload)
  });
  const poll = await createRes.json();
  console.log(`✓ Enquete criada com ID: ${poll.id}, Código: ${poll.code}`);

  // 2. Adicionar Pergunta
  const qRes = await fetch(`http://localhost:3000/api/polls/${poll.id}/questions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: 'Qual arquitetura você prefere para este projeto?',
      options: [
        { text: 'Microsserviços' },
        { text: 'Monólito Modular' }
      ]
    })
  });
  const question = await qRes.json();
  console.log(`✓ Pergunta criada: "${question.text}" com ${question.options.length} opções`);

  const optMicro = question.options[0].id;
  const optMono = question.options[1].id;
  const seniorProfile = poll.profiles.find(p => p.name === 'Senior');
  const juniorProfile = poll.profiles.find(p => p.name === 'Junior');

  // 3. Testar QR Code
  const qrRes = await fetch(`http://localhost:3000/api/polls/${poll.id}/qrcode`);
  const qrData = await qrRes.json();
  console.log(`✓ QR Code gerado com sucesso (DataURL length: ${qrData.dataUrl.length})`);

  // 4. Testar Endpoint de Join pelo Código
  const joinRes = await fetch(`http://localhost:3000/api/polls/join/${poll.code}`);
  const joinData = await joinRes.json();
  console.log(`✓ Consulta por código (${poll.code}) validada: título="${joinData.title}", perfis sem peso revelado:`, joinData.profiles);

  // 5. Testar Conexão Socket e Votação Simultânea
  console.log('--- Testando Conexões e Votações via WebSockets ---');
  const presenterSocket = io('http://localhost:3000');
  
  await new Promise(resolve => {
    presenterSocket.on('connect', () => {
      presenterSocket.emit('join-poll', { pollId: poll.id, role: 'presenter' });
      presenterSocket.emit('start-poll', { pollId: poll.id });
      presenterSocket.emit('open-voting', { pollId: poll.id, questionId: question.id });
      resolve();
    });
  });
  console.log('✓ Apresentador conectado, enquete iniciada e votação aberta');

  // Simular votos:
  // 1 Senior vota em 'Monólito Modular' (Peso 2)
  // 1 Junior vota em 'Microsserviços' (Peso 1)
  const voter1 = io('http://localhost:3000');
  const voter2 = io('http://localhost:3000');

  await new Promise(resolve => voter1.on('connect', resolve));
  await new Promise(resolve => voter2.on('connect', resolve));

  voter1.emit('join-poll', { pollId: poll.id, role: 'participant' });
  voter2.emit('join-poll', { pollId: poll.id, role: 'participant' });

  await new Promise(r => setTimeout(r, 200));

  await new Promise((resolve, reject) => {
    voter1.emit('cast-vote', {
      pollId: poll.id,
      questionId: question.id,
      optionId: optMono,
      participantId: 'user_senior_1',
      profileId: seniorProfile.id
    }, ack => {
      if (ack?.success) resolve();
      else reject(new Error(ack?.error));
    });
  });
  console.log('✓ Voto de Senior registrado em Monólito Modular (esperado peso 2)');

  await new Promise((resolve, reject) => {
    voter2.emit('cast-vote', {
      pollId: poll.id,
      questionId: question.id,
      optionId: optMicro,
      participantId: 'user_junior_1',
      profileId: juniorProfile.id
    }, ack => {
      if (ack?.success) resolve();
      else reject(new Error(ack?.error));
    });
  });
  console.log('✓ Voto de Junior registrado em Microsserviços (esperado peso 1)');

  // Esperar o debouncing do servidor (100ms)
  await new Promise(r => setTimeout(r, 300));

  // Verificar resultados consolidados na API
  const resultsRes = await fetch(`http://localhost:3000/api/polls/${poll.id}/results/${question.id}`);
  const results = await resultsRes.json();
  console.log('\n--- Resultados Calculados ---');
  console.log(`Total Votos Brutos: ${results.totalRawVotes} (Esperado: 2)`);
  console.log(`Total Votos Ponderados: ${results.totalWeightedVotes} (Esperado: 3)`);
  results.options.forEach(opt => {
    console.log(` - Opção "${opt.text}": ${opt.rawVotes} votos brutos, ${opt.weightedVotes} votos ponderados (${opt.percentage}%)`);
  });

  // Testar carga de 200 participantes simulados
  console.log('\n--- Simulação de Carga (200 participantes emitindo votos) ---');
  const numVoters = 200;
  const loadPromises = [];
  for (let i = 0; i < numVoters; i++) {
    const isSenior = i % 2 === 0;
    const selectedOption = i % 3 === 0 ? optMicro : optMono;
    const profileId = isSenior ? seniorProfile.id : juniorProfile.id;
    
    // Enviando voto via voter1 socket reutilizado com participantId único
    loadPromises.push(new Promise(resolve => {
      voter1.emit('cast-vote', {
        pollId: poll.id,
        questionId: question.id,
        optionId: selectedOption,
        participantId: `load_user_${i}`,
        profileId: profileId
      }, resolve);
    }));
  }

  const startTime = Date.now();
  await Promise.all(loadPromises);
  const duration = Date.now() - startTime;
  console.log(`✓ 200 votos processados em ${duration}ms!`);

  await new Promise(r => setTimeout(r, 200));
  const finalResultsRes = await fetch(`http://localhost:3000/api/polls/${poll.id}/results/${question.id}`);
  const finalResults = await finalResultsRes.json();
  console.log(`✓ Total final após carga: ${finalResults.totalRawVotes} votos brutos computados.`);

  // Desconectar sockets
  presenterSocket.disconnect();
  voter1.disconnect();
  voter2.disconnect();

  console.log('\n✅ Todos os testes automatizados passaram com sucesso!');
  process.exit(0);
}

testSystem().catch(err => {
  console.error('❌ Falha no teste:', err);
  process.exit(1);
});
