// bot.js (ESM)

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
} from "@discordjs/voice";
import fetch from "node-fetch";
import { PassThrough } from "stream";

/* ------------------------ health server for Render ------------------------ */
const app = express();
// Render injects a random PORT value. Fall back to 10000 locally.
const PORT = Number(process.env.PORT) || 10000;
app.get("/", (_req, res) => res.send("ok"));
app.get("/healthz", (_req, res) => res.send("ok"));
app.listen(PORT, "0.0.0.0", () => console.log(`Health server on :${PORT}`));

/* --------------------------- env & basic wiring --------------------------- */
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

/* -------------------------------- commands -------------------------------- */
const commands = [
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Bot joins your current voice channel"),
  new SlashCommandBuilder()
    .setName("say")
    .setDescription("Play a short test clip")
    .addStringOption((o) =>
      o
        .setName("text")
        .setDescription("What to say (not used yet; test clip plays)")
        .setRequired(true)
    ),
].map((c) => c.toJSON());

async function registerCommands() {
  // ensure we have the application id
  await client.application?.fetch();
  const appId = client.application?.id;
  if (!appId) throw new Error("Could not resolve application id");
  await rest.put(Routes.applicationGuildCommands(appId, GUILD_ID), {
    body: commands,
  });
  console.log("Slash commands registered.");
}

/* ------------------------------ voice player ------------------------------ */
const player = createAudioPlayer({
  behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
});
player.on("error", (e) => console.error("Audio player error:", e));
player.on(AudioPlayerStatus.Playing, () => console.log("Audio: playing"));
player.on(AudioPlayerStatus.Idle, () => console.log("Audio: idle"));

function ensureConnectionForInteraction(interaction) {
  // prefer the member's current channel; fallback to VOICE_CHANNEL_ID if provided
  const memberVC =
    interaction?.member?.voice?.channel ??
    (VOICE_CHANNEL_ID
      ? interaction.guild.channels.cache.get(VOICE_CHANNEL_ID)
      : null);

  if (!memberVC) throw new Error("Join a voice channel first.");

  const existing = getVoiceConnection(interaction.guild.id);
  if (existing) return existing;

  const conn = joinVoiceChannel({
    channelId: memberVC.id,
    guildId: memberVC.guild.id,
    adapterCreator: memberVC.guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: false,
  });
  conn.subscribe(player);
  return conn;
}

/** Stream an MP3 (or WAV) from a URL and create an audio resource */
async function getAudioResourceFor(_text) {
  // small public sample MP3; swap to your own URL any time
  //const url =
   // "https://file-examples.com/storage/fe2f2ae52e0f8a/sample3.mp3";
  const url = "https://samplelib.com/lib/preview/mp3/sample-3s.mp3";

  const res = await fetch(url);
  if (!res.ok)
    throw new Error(`Audio fetch failed: ${res.status} ${res.statusText}`);

  const stream = new PassThrough();
  res.body.pipe(stream);

  // probe stream so the voice lib knows the input type
  const probe = await demuxProbe(stream);
  return createAudioResource(probe.stream, { inputType: probe.type });
}

/* --------------------------------- events --------------------------------- */
client.once(Events.ClientReady, async () => {
  try {
    await registerCommands();
    console.log(`Logged in as ${client.user.tag}`);
  } catch (e) {
    console.error("Command registration failed:", e);
    // non-fatal — bot can still run, but commands might not appear yet
  }
});

client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand()) return;

  try {
    switch (i.commandName) {
      case "join": {
        ensureConnectionForInteraction(i);
        await i.reply({ content: "Joined ✅", ephemeral: true });
        break;
      }

      case "say": {
        ensureConnectionForInteraction(i);
        await i.deferReply({ ephemeral: true });

        const resource = await getAudioResourceFor(
          i.options.getString("text", true)
        );
        player.play(resource);

        // wait until the player actually starts
        await new Promise((resolve, reject) => {
          const onPlay = () => {
            cleanup();
            resolve();
          };
          const onErr = (err) => {
            cleanup();
            reject(err);
          };
          function cleanup() {
            player.off(AudioPlayerStatus.Playing, onPlay);
            player.off("error", onErr);
          }
          player.on(AudioPlayerStatus.Playing, onPlay);
          player.on("error", onErr);
        });

        await i.editReply("Playing now 🎤");
        break;
      }

      default:
        await i.reply({ content: "Unknown command", ephemeral: true });
    }
  } catch (e) {
    console.error(e);
    try {
      await i.reply({ content: `Error: ${e.message}`, ephemeral: true });
    } catch {
      // ignore reply errors (e.g., already replied)
    }
  }
});

/* --------------------------------- login ---------------------------------- */
client.login(DISCORD_TOKEN);



