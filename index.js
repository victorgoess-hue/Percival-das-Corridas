console.log('=== BOT INICIANDO ===');
console.log('TELEGRAM_TOKEN:', process.env.TELEGRAM_TOKEN ? 'OK' : 'NÃO ENCONTRADO');
console.log('CEREBRAS_API_KEY:', process.env.CEREBRAS_API_KEY ? 'OK' : 'NÃO ENCONTRADO');

const TelegramBot = require('node-telegram-bot-api');
const Cerebras = require('@cerebras/cerebras_cloud_sdk');

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const cerebras = new Cerebras({ apiKey: process.env.CEREBRAS_API_KEY });

const usuarios = {};

// Cerebras free tier: 8.192 tokens de contexto — manter histórico curto
const MAX_HISTORICO = 8;
const MAX_TOKENS_PLANO = 2048;
const MAX_TOKENS_CHAT  = 1024;
const MODELO = 'gpt-oss-120b'; // modelo mais capaz do Cerebras

const PERGUNTAS = [
  '👋 Olá! Sou o <b>Professor Pace</b>, seu treinador pessoal de corrida!\n\nVamos montar seu plano personalizado. Primeira pergunta:\n\n<b>Qual é o seu nome?</b>',
  '📅 Quantos <b>anos</b> você tem?',
  '⚖️ Qual é o seu <b>peso aproximado</b> (em kg)?',
  '🏃 Como você descreveria seu <b>nível atual de corrida?</b>\n\n1 - Nunca corri\n2 - Corro ocasionalmente\n3 - Corro regularmente (1-2x semana)\n4 - Corro 3-4x semana\n5 - Corredor experiente',
  '📏 Qual a <b>maior distância</b> que você já correu de uma vez? (ex: 5km, 10km, nunca corri)',
  '⏱️ Se você corre, qual é seu <b>pace médio</b> aproximado? (ex: 6:30/km)\nSe nunca correu, escreva: <b>não sei</b>',
  '🎯 Qual é o seu <b>objetivo principal?</b>\n\n1 - Começar a correr do zero\n2 - Melhorar meu condicionamento\n3 - Correr 5km\n4 - Correr 10km\n5 - Correr meia maratona ou mais\n6 - Emagrecer correndo',
  '📆 Quantos <b>dias por semana</b> você pode treinar?',
  '🏋️ Você faz alguma outra <b>atividade física</b> além de correr? (musculação, natação, ciclismo, etc)\nSe não, escreva: <b>não</b>',
  '⚠️ Você tem alguma <b>lesão ou limitação física</b> que devo considerar?\nSe não, escreva: <b>não</b>',
  '🏁 Tem alguma <b>prova ou data</b> que quer se preparar?\n(ex: 10km em setembro, maratona em dezembro)\nSe não, escreva: <b>não</b>',
];

const SYSTEM_PROMPT_BASE = `Você é o Professor Pace, um treinador de corrida experiente, didático e motivador.
Você atende alunos de todos os níveis, desde iniciantes até corredores avançados.
Use tom professoral, empático e encorajador.
Use emojis relevantes e deixe pontos importantes em negrito com tags HTML (<b>texto</b>).
NÃO use Markdown (como *texto* ou _texto_). Use apenas HTML simples: <b> para negrito, <i> para itálico.
Ao montar planos, considere sempre:
- Progressão gradual e segura
- Prevenção de lesões
- Equilíbrio entre treino e descanso
- Motivação e adesão ao plano
Quando o aluno reportar treinos, analise pace, distância e sensação para dar feedback preciso.
Seja objetivo e direto nas respostas para não ultrapassar o limite de tokens.`;

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

// Trunca o histórico para não estourar o limite de contexto (8.192 tokens no free tier)
function truncarHistorico(historico) {
  if (historico.length <= MAX_HISTORICO) return historico;
  return historico.slice(historico.length - MAX_HISTORICO);
}

// Envia mensagem longa em partes com parse_mode HTML
async function enviarMensagemLonga(chatId, texto) {
  const LIMITE = 4000;
  const partes = [];
  let t = texto;
  while (t.length > 0) {
    partes.push(t.substring(0, LIMITE));
    t = t.substring(LIMITE);
  }
  for (const parte of partes) {
    try {
      await bot.sendMessage(chatId, parte, { parse_mode: 'HTML' });
    } catch (err) {
      console.warn('Falha ao enviar com HTML, enviando sem formatação:', err.message);
      await bot.sendMessage(chatId, parte);
    }
  }
}

async function gerarPlanoInicial(chatId) {
  const usuario = usuarios[chatId];
  const systemPrompt = buildSystemPrompt(usuario.perfil);

  const mensagemGerarPlano = `Apresente-se brevemente e monte um plano de treino personalizado completo para ${usuario.perfil.nome} com base no perfil dele. Inclua semanas, treinos por dia, paces recomendados e dicas importantes. Seja detalhado e motivador. Use tags HTML para formatação (<b> para negrito).`;

  try {
    const resultado = await cerebras.chat.completions.create({
      model: MODELO,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: mensagemGerarPlano },
      ],
      max_tokens: MAX_TOKENS_PLANO,
    });

    const resposta = resultado.choices[0].message.content;
    usuario.historico = [
      { role: 'user', content: mensagemGerarPlano },
      { role: 'assistant', content: resposta },
    ];
    usuario.systemPrompt = systemPrompt;
    usuario.onboarding = false;

    await enviarMensagemLonga(chatId, resposta);
    await bot.sendMessage(
      chatId,
      `✅ Plano criado! Agora é só me contar como foram seus treinos, ${usuario.perfil.nome}! 💪`
    );

  } catch (err) {
    console.error('Erro ao gerar plano:', err.message);
    bot.sendMessage(chatId, 'Ocorreu um erro ao gerar seu plano. Tente novamente com /start');
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
  bot.sendMessage(chatId, PERGUNTAS[0], { parse_mode: 'HTML' });
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const texto = msg.text;

  if (!texto) {
    bot.sendMessage(chatId, 'Por favor, envie apenas mensagens de texto. 🏃‍♂️');
    return;
  }

  if (texto === '/start') return;

  if (!usuarios[chatId]) {
    bot.sendMessage(chatId, 'Olá! Digite /start para começar. 🏃‍♂️');
    return;
  }

  const usuario = usuarios[chatId];

  if (usuario.onboarding) {
    const campo = CAMPOS_PERFIL[usuario.etapa];
    usuario.perfil[campo] = texto;
    usuario.etapa++;

    if (usuario.etapa < PERGUNTAS.length) {
      bot.sendMessage(chatId, PERGUNTAS[usuario.etapa], { parse_mode: 'HTML' });
    } else {
      await bot.sendMessage(chatId, '⏳ Perfeito! Estou montando seu plano personalizado, aguarde um momento...');
      await gerarPlanoInicial(chatId);
    }
    return;
  }

  usuario.historico.push({ role: 'user', content: texto });

  try {
    const historicoTruncado = truncarHistorico(usuario.historico);

    const resultado = await cerebras.chat.completions.create({
      model: MODELO,
      messages: [
        { role: 'system', content: usuario.systemPrompt },
        ...historicoTruncado,
      ],
      max_tokens: MAX_TOKENS_CHAT,
    });

    const resposta = resultado.choices[0].message.content;
    usuario.historico.push({ role: 'assistant', content: resposta });
    await enviarMensagemLonga(chatId, resposta);

  } catch (err) {
    console.error('Erro ao chamar Cerebras:', err.message);

    // Rate limit ou contexto estourado: limpa histórico e avisa
    if (err.status === 429 || err.status === 413) {
      usuario.historico = [];
      bot.sendMessage(
        chatId,
        '⚠️ Limite temporário atingido, precisei reiniciar o histórico. Pode repetir sua última mensagem?'
      );
    } else {
      bot.sendMessage(chatId, 'Ocorreu um erro, tente novamente.');
    }
  }
});

console.log('Bot iniciado! Aguardando mensagens...');
