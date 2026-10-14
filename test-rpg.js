const { io } = require('socket.io-client');

async function testScenarioRPG() {
  console.log('--- Iniciando Teste do Novo Sistema de Pesos por Pergunta e Alternativa ---');

  // Cenário do Usuário:
  // Perfis: Peixe, Pássaro e Gato
  // Pergunta 1:
  // "Por onde devemos seguir o caminho?"
  // Alternativas:
  // - Mar: Peixe tem peso 3.0, Pássaro tem peso 1.0, Gato tem peso 0.5 (ou 1.0)
  // - Terra: Gato tem peso 3.0, Pássaro tem peso 1.0, Peixe tem peso 1.0
  // - Ar: Pássaro tem peso 3.0, Peixe tem peso 1.0, Gato tem peso 1.0

  // 1. Criar a Enquete com os 3 perfis
  const pollPayload = {
    title: 'Jornada dos Animais Mágicos',
    description: 'Enquete RPG interativa com pesos por alternativa e perfil',
    hasProfiles: true,
    profiles: [
      { name: 'Peixe' },
      { name: 'Pássaro' },
      { name: 'Gato' }
    ]
  };

  const createRes = await fetch('http://localhost:3000/api/polls', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(pollPayload)
  });
  const poll = await createRes.json();
  console.log(`✓ Enquete criada: "${poll.title}" (Código: ${poll.code})`);

  const peixeProfile = poll.profiles.find(p => p.name === 'Peixe');
  const passaroProfile = poll.profiles.find(p => p.name === 'Pássaro');
  const gatoProfile = poll.profiles.find(p => p.name === 'Gato');

  console.log(`✓ Perfis cadastrados: Peixe (${peixeProfile.id}), Pássaro (${passaroProfile.id}), Gato (${gatoProfile.id})`);

  // 2. Criar a Pergunta 1 com pesos diferenciados por alternativa:
  // Mar: Peixe = 3, Pássaro = 1, Gato = 1
  // Terra: Gato = 3, Peixe = 1, Pássaro = 1
  // Ar: Pássaro = 3, Peixe = 1, Gato = 1
  const q1Payload = {
    text: 'Por onde devemos seguir o caminho?',
    options: [
      {
        text: 'Mar',
        weights: {
          [peixeProfile.id]: 3.0,
          [passaroProfile.id]: 1.0,
          [gatoProfile.id]: 1.0
        }
      },
      {
        text: 'Terra',
        weights: {
          [peixeProfile.id]: 1.0,
          [passaroProfile.id]: 1.0,
          [gatoProfile.id]: 3.0
        }
      },
      {
        text: 'Ar',
        weights: {
          [peixeProfile.id]: 1.0,
          [passaroProfile.id]: 3.0,
          [gatoProfile.id]: 1.0
        }
      }
    ]
  };

  const q1Res = await fetch(`http://localhost:3000/api/polls/${poll.id}/questions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(q1Payload)
  });
  const q1 = await q1Res.json();
  console.log(`✓ Pergunta 1 cadastrada: "${q1.text}"`);

  const optMar = q1.options.find(o => o.text === 'Mar').id;
  const optTerra = q1.options.find(o => o.text === 'Terra').id;
  const optAr = q1.options.find(o => o.text === 'Ar').id;

  // 3. Conectar Apresentador e Iniciar Votação da Pergunta 1
  const presenter = io('http://localhost:3000');
  await new Promise(res => presenter.on('connect', res));
  presenter.emit('join-poll', { pollId: poll.id, role: 'presenter' });
  presenter.emit('start-poll', { pollId: poll.id });
  presenter.emit('open-voting', { pollId: poll.id, questionId: q1.id });
  console.log('✓ Apresentador iniciou a votação da Pergunta 1');

  // 4. Conectar Votantes (Peixe 1, Peixe 2, Gato 1)
  // Caso de teste:
  // - Peixe 1 vota no Mar -> Deve receber peso 3.0 (peso maior por ser Peixe votando em Mar)
  // - Peixe 2 vota na Terra -> Deve receber peso 1.0 (peso normal de Peixe votando em Terra)
  // - Gato 1 vota no Mar -> Deve receber peso 1.0 (peso normal de Gato votando em Mar)
  const voterPeixe1 = io('http://localhost:3000');
  const voterPeixe2 = io('http://localhost:3000');
  const voterGato1 = io('http://localhost:3000');

  await Promise.all([
    new Promise(res => voterPeixe1.on('connect', res)),
    new Promise(res => voterPeixe2.on('connect', res)),
    new Promise(res => voterGato1.on('connect', res))
  ]);

  voterPeixe1.emit('join-poll', { pollId: poll.id, role: 'participant' });
  voterPeixe2.emit('join-poll', { pollId: poll.id, role: 'participant' });
  voterGato1.emit('join-poll', { pollId: poll.id, role: 'participant' });

  await new Promise(r => setTimeout(r, 100));

  // Votar Peixe 1 no Mar
  await new Promise((resolve, reject) => {
    voterPeixe1.emit('cast-vote', {
      pollId: poll.id,
      questionId: q1.id,
      optionId: optMar,
      participantId: 'p_peixe_1',
      profileId: peixeProfile.id
    }, ack => ack?.success ? resolve() : reject(ack?.error));
  });
  console.log('✓ Peixe 1 votou no Mar (esperado peso: 3.0)');

  // Votar Peixe 2 na Terra
  await new Promise((resolve, reject) => {
    voterPeixe2.emit('cast-vote', {
      pollId: poll.id,
      questionId: q1.id,
      optionId: optTerra,
      participantId: 'p_peixe_2',
      profileId: peixeProfile.id
    }, ack => ack?.success ? resolve() : reject(ack?.error));
  });
  console.log('✓ Peixe 2 votou na Terra (esperado peso: 1.0)');

  // Votar Gato 1 no Mar
  await new Promise((resolve, reject) => {
    voterGato1.emit('cast-vote', {
      pollId: poll.id,
      questionId: q1.id,
      optionId: optMar,
      participantId: 'p_gato_1',
      profileId: gatoProfile.id
    }, ack => ack?.success ? resolve() : reject(ack?.error));
  });
  console.log('✓ Gato 1 votou no Mar (esperado peso: 1.0)');

  // Aguardar debouncing
  await new Promise(r => setTimeout(r, 250));

  // 5. Validar Resultados da Pergunta 1
  const resQ1 = await (await fetch(`http://localhost:3000/api/polls/${poll.id}/results/${q1.id}`)).json();
  console.log('\n--- Resultados Consolidados da Pergunta 1 ---');
  console.log(`Total Votos Brutos: ${resQ1.totalRawVotes} (Esperado: 3)`);
  console.log(`Total Votos Ponderados: ${resQ1.totalWeightedVotes} (Esperado: 3 + 1 + 1 = 5.0)`);

  const marResult = resQ1.options.find(o => o.text === 'Mar');
  const terraResult = resQ1.options.find(o => o.text === 'Terra');

  console.log(` - Opção Mar: ${marResult.rawVotes} votos brutos, ${marResult.weightedVotes} ponderados (${marResult.percentage}%) - Esperado: 2 brutos, 4.0 ponderados (80%)`);
  console.log(` - Opção Terra: ${terraResult.rawVotes} votos brutos, ${terraResult.weightedVotes} ponderados (${terraResult.percentage}%) - Esperado: 1 bruto, 1.0 ponderado (20%)`);

  if (marResult.weightedVotes !== 4 || terraResult.weightedVotes !== 1) {
    throw new Error('Falha nos pesos da Pergunta 1!');
  }

  // 6. Testar Pergunta 2 com novas regras de peso (ex: organizador altera as regras)
  const q2Payload = {
    text: 'Como devemos acampar hoje à noite?',
    options: [
      {
        text: 'Em uma caverna no chão',
        weights: {
          [peixeProfile.id]: 1.0,
          [passaroProfile.id]: 1.0,
          [gatoProfile.id]: 5.0 // Gato agora tem peso 5 nesta alternativa
        }
      },
      {
        text: 'No topo das árvores',
        weights: {
          [peixeProfile.id]: 1.0,
          [passaroProfile.id]: 4.0, // Pássaro tem peso 4 nesta alternativa
          [gatoProfile.id]: 2.0
        }
      }
    ]
  };

  const q2Res = await fetch(`http://localhost:3000/api/polls/${poll.id}/questions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(q2Payload)
  });
  const q2 = await q2Res.json();
  console.log(`\n✓ Pergunta 2 cadastrada com regras totalmente novas: "${q2.text}"`);

  const optCaverna = q2.options[0].id;
  presenter.emit('change-question', { pollId: poll.id, questionId: q2.id });
  presenter.emit('open-voting', { pollId: poll.id, questionId: q2.id });
  await new Promise(r => setTimeout(r, 100));

  // Gato 1 vota em Caverna na Pergunta 2 (esperado peso 5.0)
  await new Promise((resolve, reject) => {
    voterGato1.emit('cast-vote', {
      pollId: poll.id,
      questionId: q2.id,
      optionId: optCaverna,
      participantId: 'p_gato_1',
      profileId: gatoProfile.id
    }, ack => ack?.success ? resolve() : reject(ack?.error));
  });

  await new Promise(r => setTimeout(r, 250));
  const resQ2 = await (await fetch(`http://localhost:3000/api/polls/${poll.id}/results/${q2.id}`)).json();
  const cavernaResult = resQ2.options.find(o => o.text === 'Em uma caverna no chão');
  console.log(` - Pergunta 2 Caverna: ${cavernaResult.rawVotes} voto bruto, ${cavernaResult.weightedVotes} votos ponderados (Esperado: 5.0)`);

  if (cavernaResult.weightedVotes !== 5) {
    throw new Error('Falha nos pesos da Pergunta 2!');
  }

  // Finalizar conexões
  presenter.disconnect();
  voterPeixe1.disconnect();
  voterPeixe2.disconnect();
  voterGato1.disconnect();

  console.log('\n✅ Novo modelo de pesos por pergunta e por alternativa validado com 100% de sucesso!');
  process.exit(0);
}

testScenarioRPG().catch(err => {
  console.error('❌ Erro no teste do cenário RPG:', err);
  process.exit(1);
});
