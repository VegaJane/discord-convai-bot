// bot.js (stable with early defer + timeouts + verbose logs)

import "dotenv/config";
import express from "express";
import {
  Client,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  Routes,
  Events,
} from "discord.js";
import { REST } from "@discordjs/rest";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  NoSubscriberBehavior,
  AudioPlayerStatus,
  demuxProbe,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState,
} from "@discordjs/voice";
import fetch from "node-fetch";
import { PassThrough } from "stream";

/* ------------------------ Health server for Render ------------------------ */
const app = express();
const PORT = Number(process.env.PORT) || 10000;
app.get("/", (_req, res) => res.send("ok"));
app.get("/healthz", (_req, res) => res.send("ok"));
app.listen(PORT, "0.0.0.0", () => console.log(`Health server on :${PORT}`));

/* --------------------------- Env & basic wiring --------------------------- */
const { DISCORD_TOKEN, GUILD_ID, VOICE_CHANNEL_ID } = process.env;
if (!DISCORD_TOKEN || !GUILD_ID) {
  console.error("Set DISCORD_TOKEN & GUILD_ID");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  partials: [Partials.Channel],
});

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

/* -------------------------------- Commands -------------------------------- */
const commands = [
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Bot joins your current voice channel"),
  new SlashCommandBuilder()
    .setName("say")
    .setDescription("Play a short test clip")
    .addStringOption((o) =>
      o.setName("text").setDescription("What to say (test clip plays)").setRequired(true)
    ),
].map((c) => c.toJSON());

async function registerCommands() {
  await client.application?.fetch();
  const appId = client.application?.id;
  if (!appId) throw new Error("Could not resolve application id");
  await rest.put(Routes.applicationGuildCommands(appId, GUILD_ID), { body: commands });
  console.log("Slash commands registered.");
}

/* ------------------------------ Voice player ------------------------------ */
const player = createAudioPlayer({
  behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
});
player.on("error", (e) => console.error("Audio player error:", e));
player.on(AudioPlayerStatus.Playing, () => console.log("Audio: playing"));
player.on(AudioPlayerStatus.Idle, () => console.log("Audio: idle"));

/* Ensure connection is ready & subscribed every time */
async function ensureConnectionForInteraction(interaction) {
  console.log("[ensure] start");
  const memberVC =
    interaction?.member?.voice?.channel ??
    (VOICE_CHANNEL_ID ? interaction.guild.channels.cache.get(VOICE_CHANNEL_ID) : null);

  if (!memberVC) throw new Error("Join a voice channel first.");

  let conn = getVoiceConnection(interaction.guild.id);
  if (!conn) {
    console.log("[ensure] creating new voice connection");
    conn = joinVoiceChannel({
      channelId: memberVC.id,
      guildId: memberVC.guild.id,
      adapterCreator: memberVC.guild.voiceAdapterCreator,
      selfDeaf: true,   // ok for output-only
      selfMute: false,
    });
  } else {
    console.log("[ensure] reusing existing voice connection");
  }

  await entersState(conn, VoiceConnectionStatus.Ready, 10_000);
  conn.subscribe(player);
  console.log("[ensure] ready & subscribed");
  return conn;
}

/* Fetch with timeout helper */
async function fetchWithTimeout(url, ms = 8000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

/* Stream small OGG (preferred) with MP3 fallback, explicit volume */
async function getAudioResourceFor(_text) {
  console.log("[audio] fetching");
  const urls = [
    "https://upload.wikimedia.org/wikipedia/commons/c/c8/Example.ogg", // tiny OGG
    "https://samplelib.com/lib/preview/mp3/sample-3s.mp3",             // fallback MP3
  ];

  for (const url of urls) {
    try {
      console.log("[audio] try:", url);
      const res = await fetchWithTimeout(url, 8000);
      if (!res.ok) {
        console.log("[audio] non-200:", res.status);
        continue;
      }

      const stream = new PassThrough();
      res.body.pipe(stream);

      const probe = await demuxProbe(stream);
      const resource = createAudioResource(probe.stream, {
        inputType: probe.type,
        inlineVolume: true,
      });
      resource.volume?.setVolume(1.15);
      console.log("[audio] ready");
      return resource;
    } catch (e) {
      console.log("[audio] fetch/probe error, trying next:", e?.message || e);
    }
  }
  throw new Error("Audio fetch failed for all sources.");
}

/* --------------------------------- Events --------------------------------- */
client.once(Events.ClientReady, async () => {
  try {
    await registerCommands();
    console.log(`Logged in as ${client.user.tag}`);
  } catch (e) {
    console.error("Command registration failed:", e);
  }
});

client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand()) return;

  try {
    if (i.commandName === "join") {
      // Defer immediately to avoid "thinking..." timeouts
      await i.deferReply({ ephemeral: true });
      await ensureConnectionForInteraction(i);
      await i.editReply("Joined ✅");
      return;
    }

    if (i.commandName === "say") {
      // Defer immediately, BEFORE any awaits
      await i.deferReply({ ephemeral: true });
      console.log("[say] deferred");

      await ensureConnectionForInteraction(i);
      console.log("[say] connection ready");

      const resource = await getAudioResourceFor(i.options.getString("text", true));
      console.log("[say] resource ready — playing");
      player.play(resource);

      // Wait until the player actually starts (or errors)
      await new Promise((resolve, reject) => {
        const onPlay = () => { cleanup(); resolve(); };
        const onErr = (err) => { cleanup(); reject(err); };
        function cleanup() {
          player.off(AudioPlayerStatus.Playing, onPlay);
          player.off("error", onErr);
        }
        player.on(AudioPlayerStatus.Playing, onPlay);
        player.on("error", onErr);
      });

      await i.editReply("Playing now 🎤");
      console.log("[say] reply sent");
      return;
    }

    await i.reply({ content: "Unknown command", ephemeral: true });
  } catch (e) {
    console.error("[handler error]", e);
    // Try to respond gracefully no matter what state the interaction is in
    try {
      if (i.deferred || i.replied) {
        await i.editReply(`Error: ${e.message || e}`);
      } else {
        await i.reply({ content: `Error: ${e.message || e}`, ephemeral: true });
      }
    } catch {}
  }
});

/* --------------------------------- Login ---------------------------------- */
client.login(DISCORD_TOKEN);
