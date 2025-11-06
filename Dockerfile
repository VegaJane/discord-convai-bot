import 'dotenv/config';
import express from 'express';
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events
} from 'discord.js';
import {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,
  VoiceConnectionStatus
} from '@discordjs/voice';
import fetch from 'node-fetch';
import { PassThrough } from 'stream';

const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (_req, res) => res.send('ok'));
app.listen(PORT, () => console.log(`Health server on :${PORT}`));

const {
  DISCORD_TOKEN,
  GUILD_ID,
  VOICE_CHANNEL_ID,
  CONVAI_API_KEY,
  CONVAI_CHARACTER_ID,
  CONVAI_API_URL
} = process.env;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel],
});

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
});

let isPaused = false;
const player = createAudioPlayer();
player.on('error', (e) => console.error('Audio player error:', e));
player.on(AudioPlayerStatus.Playing, () => console.log('Audio: playing'));
player.on(AudioPlayerStatus.Idle, () => console.log('Audio: idle'));

async function joinChannel(guildId, voiceChannelId) {
  const guild = await client.guilds.fetch(guildId);
  const channel = await guild.channels.fetch(voiceChannelId);

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: false,
  });

  connection.on(VoiceConnectionStatus.Ready, () => {
    console.log('Voice connection ready');
  });
  connection.on('error', (e) => console.error('Voice connection error:', e));

  connection.subscribe(player);
}

function leaveChannel(guildId) {
  const conn = getVoiceConnection(guildId);
  if (conn) conn.destroy();
}

function setPaused(flag) {
  isPaused = flag;
  console.log(`Listening paused: ${isPaused}`);
}

async function playAudioFromUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Audio fetch failed: ${res.status} ${res.statusText}`);

  const stream = new PassThrough();
  res.body.pipe(stream);

  const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary });
  player.play(resource);

  return new Promise((resolve, reject) => {
    const onIdle = () => { cleanup(); resolve(); };
    const onError = (err) => { cleanup(); reject(err); };
    function cleanup() {
      player.off(AudioPlayerStatus.Idle, onIdle);
      player.off('error', onError);
    }
    player.on(AudioPlayerStatus.Idle, onIdle);
    player.on('error', onError);
  });
}

async function callConvai(prompt) {
  if (!CONVAI_API_KEY || !CONVAI_CHARACTER_ID || !CONVAI_API_URL) {
    return { text: `(dev echo) ${prompt}`, audioUrl: null };
  }

  const resp = await fetch(CONVAI_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CONVAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      character_id: CONVAI_CHARACTER_ID,
      query: prompt,
      voice: { format: 'wav' }
    })
  });

  if (!resp.ok) throw new Error(`Convai call failed: ${resp.status} ${resp.statusText}`);

  const data = await resp.json();
  return {
    text: data.text || data.reply || data.message || '',
    audioUrl: data.audioUrl || data.audio_url || null
  };
}

const PREFIX = '!';
client.on(Events.MessageCreate, async (msg) => {
  try {
    if (msg.author.bot) return;
    if (!msg.content.startsWith(PREFIX)) return;

    const [cmd, ...rest] = msg.content.slice(PREFIX.length).trim().split(/\s+/);
    const argLine = rest.join(' ');

    switch (cmd.toLowerCase()) {
      case 'join': {
        const guildId = msg.guild?.id || GUILD_ID;
        const vcId = VOICE_CHANNEL_ID || msg.member?.voice?.channelId;
        if (!guildId || !vcId) {
          await msg.reply('Join failed: join a voice channel first or set VOICE_CHANNEL_ID.');
          return;
        }
        await joinChannel(guildId, vcId);
        await msg.reply('Joined voice channel.');
        break;
      }

      case 'leave': {
        const guildId = msg.guild?.id || GUILD_ID;
        leaveChannel(guildId);
        await msg.reply('Left voice channel.');
        break;
      }

      case 'pause': {
        setPaused(true);
        await msg.reply('Bot listening **paused**. I will not send requests to Convai.');
        break;
      }

      case 'resume': {
        setPaused(false);
        await msg.reply('Bot listening **resumed**.');
        break;
      }

      case 'ask': {
        if (!argLine) { await msg.reply('Usage: `!ask <your question>`'); return; }
        if (isPaused) { await msg.reply('I’m paused. Use `!resume` first.'); return; }

        await msg.channel.sendTyping();
        const { text, audioUrl } = await callConvai(argLine);

        if (text) await msg.reply(text);

        const guildId = msg.guild?.id || GUILD_ID;
        const conn = guildId ? getVoiceConnection(guildId) : null;
        if (conn && audioUrl) {
          try { await playAudioFromUrl(audioUrl); }
          catch (e) {
            console.error('Audio playback failed:', e);
            await msg.reply('Could not play the audio response (format/URL?).');
          }
        }
        break;
      }

      default:
        await msg.reply(
          [
            '**Commands:**',
            '`!join` — join your current voice channel',
            '`!leave` — leave voice channel',
            '`!pause` / `!resume` — toggle listening',
            '`!ask <text>` — send to Convai (plays voice if available)',
          ].join('\n')
        );
    }
  } catch (err) {
    console.error('Command error:', err);
    try { await msg.reply('Error: ' + (err?.message || 'unknown')); } catch {}
  }
});

client.login(DISCORD_TOKEN);
