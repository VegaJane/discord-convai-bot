import "dotenv/config";
import { Client, GatewayIntentBits, Partials, SlashCommandBuilder, Routes } from "discord.js";
import { REST } from "@discordjs/rest";
import { joinVoiceChannel, createAudioPlayer, createAudioResource, NoSubscriberBehavior, AudioPlayerStatus } from "@discordjs/voice";

const { DISCORD_TOKEN, GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !GUILD_ID) { console.error("Set DISCORD_TOKEN & GUILD_ID"); process.exit(1); }

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates], partials: [Partials.Channel] });

const commands = [
  new SlashCommandBuilder().setName("join").setDescription("Bot joins your current voice channel"),
  new SlashCommandBuilder().setName("say").setDescription("Play a test line").addStringOption(o => o.setName("text").setDescription("What to say").setRequired(true))
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
player.on(AudioPlayerStatus.Idle, () => {});
player.on("error", (e) => console.error("Audio error:", e));

function joinUserChannel(interaction) {
  const vc = interaction.member?.voice?.channel;
  if (!vc) throw new Error("Join a voice channel first.");
  const conn = joinVoiceChannel({ channelId: vc.id, guildId: vc.guild.id, adapterCreator: vc.guild.voiceAdapterCreator, selfDeaf: false });
  conn.subscribe(player);
  return conn;
}

// TEMP audio; we’ll replace with Convai later
async function getAudioResourceFor(text) {
  const url = "https://file-examples.com/storage/fe2f2ae52e0f8a/sample3.mp3";
  return createAudioResource(url, { inlineVolume: true });
}

async function registerCommands() {
  const appId = (await client.application?.fetch())?.id || client.user.id;
  await rest.put(Routes.applicationGuildCommands(appId, GUILD_ID), { body: commands });
}

client.once("ready", async () => { await registerCommands(); console.log(`Logged in as ${client.user.tag}`); });

client.on("interactionCreate", async (i) => {
  if (!i.isChatInputCommand()) return;
  try {
    if (i.commandName === "join") { joinUserChannel(i); return i.reply({ content: "Joined ✅", ephemeral: true }); }
    if (i.commandName === "say") {
      joinUserChannel(i);
      await i.deferReply({ ephemeral: true });
      const resource = await getAudioResourceFor(i.options.getString("text", true));
      player.play(resource);
      return i.editReply("Playing now 🎤");
    }
  } catch (e) { console.error(e); i.reply({ content: `Error: ${e.message}`, ephemeral: true }).catch(() => {}); }
});

client.login(DISCORD_TOKEN);
