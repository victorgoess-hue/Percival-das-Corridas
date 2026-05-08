console.log('=== BOT INICIANDO ===');
console.log('TELEGRAM_TOKEN:', process.env.TELEGRAM_TOKEN ? 'OK' : 'NÃO ENCONTRADO');
console.log('GROQ_API_KEY:', process.env.GROQ_API_KEY ? 'OK' : 'NÃO ENCONTRADO');

const TelegramBot = require('node-telegram-bot-api');
const Groq = require('groq-sdk');

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Estado de cada usuário
const usuarios = {};

const PERGUNTAS = [
  '👋 Olá! Sou o *Professor Pace*, seu treinador pessoal de corrida!\n\nVamos montar seu plano personalizado. Primeira pergunta:\n\n*Qual é o seu nome?*',
  '📅 Quantos *anos* você tem?',
  '⚖️ Qual é o seu *peso aproximado* (em kg)?',
  '🏃 Como você descreveria seu *nível atual de corrida?*\n\n1 - Nunca corri\n2 - Corro ocasionalmente\n3 - Corro regularmente (1-2x semana)\n4 - Corro 3-4x semana\n5 - Corredor experiente',
  '📏 Qual a *maior distância* que você já correu de uma vez? (ex: 5km, 10km, nunca corri)',
  '⏱️ Se você corre, qual é seu *pace médio* aproximado? (ex: 6:30/km)\nSe nunca correu, escreva: *não sei*',
  '🎯 Qual é o seu *objetivo principal?*\n\n1 - Começar a correr do zero\n2 - Melhorar meu condicionamento\n3 - Correr 5km\n4 - Correr 10km\n5 - Correr meia maratona ou mais\n6 - Emagrecer correndo',
  '📆 Quantos *dias por semana* você pode treinar?',
  '🏋️ Você faz alguma outra *atividade física* além de correr? (musculação, natação, ciclismo, etc)\nSe não, escreva: *não*',
  '⚠️ Você tem alguma *lesão ou limitação física* que devo considerar?\nSe não, escreva: *não*',
  '🏁 Tem alguma *prova ou data* que quer se preparar?\n(ex: 10km em setembro, maratona em dezembro)\nSe não, escreva: *não*',
];

const SYSTEM_PROMPT_BASE = `Você é o Professor Pace, um treinador de corrida experiente, didático e motivador.
Você atende alunos de todos os níveis, desde iniciantes até corredores avançados.
Use tom professoral, empático e encorajador.
Use emojis relevantes e deixe pontos importantes em *negrito* com asteriscos simples.
Ao montar planos, considere sempre:
- Progressão gradual e segura
- Prevenção de lesões
- Equilíbrio entre treino e descanso
- Motivação e adesão ao plano
Quando o aluno reportar treinos, analise pace, distância e sensação para dar feedback preciso.`;

function buildSystemPrompt(perfil) {
  return `${SYSTEM_PROMPT_BASE}

# PERFIL DO ALUNO
- Nome: ${perfil.nome}
- Idade: ${perfil.idade} anos
- Peso: ${perfil.peso} kg
- Nível: ${perfil.nivel}
- Maior distância já corrida: ${perfil.distancia}
- Pace médio atual: ${perfil.pace}
- Objetivo: ${perfil.objetivo}
- Dias disponíveis por semana: ${perfil.dias}
- Outras atividades: ${perfil.atividades}
- Lesões/limitações: ${perfil.lesoes}
- Prova alvo: ${perfil.prova}

Com base nesse perfil, você já montou um plano personalizado para este aluno.
Acompanhe o progresso dele, responda dúvidas e ajuste o plano conforme necessário.`;
}

const CAMPOS_PERFIL = [
  'nome', 'idade', 'peso', 'nivel', 'distancia',
  'pace', 'objetivo', 'dias', 'atividades', 'lesoes', 'prova'
];

async function gerarPlanoInicial(chatId) {
  const usuario = usuarios[chatId];
  const systemPrompt = buildSystemPrompt(usuario.perfil);

  const mensagemGerarPlano = `Apresente-se brevemente e monte um plano de treino personalizado completo para ${usuario.perfil.nome} com base no perfil dele. Inclua semanas, treinos por dia, paces recomendados e dicas importantes. Seja detalhado e motivador.`;

  try {
    const resultado = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: mensagemGerarPlano },
      ],
      max_tokens: 8192,
    });

    const resposta = resultado.choices[0].message.content;
    usuario.historico = [
      { role: 'user', content: mensagemGerarPlano },
      { role: 'assistant', content: resposta },
    ];
    usuario.systemPrompt = systemPrompt;
    usuario.onboarding = false;

    await enviarMensagemLonga(chatId, resposta);
    await bot.sendMessage(chatId, '✅ Plano criado! Agora é só me contar como foram seus treinos e terei todo o prazer em acompanhar sua evolução, *' + usuario.perfil.nome + '*! 💪', { parse_mode: 'Markdown' });

  } catch (err) {
    console.error('Erro ao gerar plano:', err.message);
    bot.sendMessage(chatId, 'Ocorreu um erro ao gerar seu plano. Tente novamente com /start');
  }
}

async function enviarMensagemLonga(chatId, texto) {
  const LIMITE = 4000;
  if (texto.length <= LIMITE) {
    await bot.sendMessage(chatId, texto, { parse_mode: 'Markdown' });
  } else {
    const partes = [];
    let t = texto;
    while (t.length > 0) {
      partes.push(t.substring(0, LIMITE));
      t = t.substring(LIMITE);
    }
    for (const parte of partes) {
      await bot.sendMessage(chatId, parte, { parse_mode: 'Markdown' });
    }
  }
}

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  usuarios[chatId] = {
    onboarding: true,
    etapa: 0,
    perfil: {},
    historico: [],
    systemPrompt: '',
  };
  bot.sendMessage(chatId, PERGUNTAS[0], { parse_mode: 'Markdown' });
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const texto = msg.text;

  if (!texto) {
    bot.sendMessage(chatId, 'Por favor, envie apenas mensagens de texto. 🏃‍♂️');
    return;
  }

  if (texto === '/start') return;

  // Usuário novo sem /start
  if (!usuarios[chatId]) {
    bot.sendMessage(chatId, 'Olá! Digite /start para começar. 🏃‍♂️');
    return;
  }

  const usuario = usuarios[chatId];

  // Onboarding
  if (usuario.onboarding) {
    const campo = CAMPOS_PERFIL[usuario.etapa];
    usuario.perfil[campo] = texto;
    usuario.etapa++;

    if (usuario.etapa < PERGUNTAS.length) {
      bot.sendMessage(chatId, PERGUNTAS[usuario.etapa], { parse_mode: 'Markdown' });
    } else {
      await bot.sendMessage(chatId, '⏳ Perfeito! Estou montando seu plano personalizado, aguarde um momento...', { parse_mode: 'Markdown' });
      await gerarPlanoInicial(chatId);
    }
    return;
  }

  // Chat normal após onboarding
  usuario.historico.push({ role: 'user', content: texto });

  try {
    const resultado = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: usuario.systemPrompt },
        ...usuario.historico,
      ],
      max_tokens: 8192,
    });

    const resposta = resultado.choices[0].message.content;
    usuario.historico.push({ role: 'assistant', content: resposta });
    await enviarMensagemLonga(chatId, resposta);

  } catch (err) {
    console.error('Erro ao chamar Groq:', err.message);
    bot.sendMessage(chatId, 'Ocorreu um erro, tente novamente.');
  }
});

console.log('Bot iniciado! Aguardando mensagens...');
