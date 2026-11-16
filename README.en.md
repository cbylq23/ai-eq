# AI EQ — AI song brief & genre-driven equalizer for Folia

AI EQ reads the full lyrics of the song you are playing, asks your own OpenAI-compatible provider for a short **song brief** (one-line summary, mood, style tags, imagery, energy arc) and a **10-band EQ curve**, then applies it to Folia's built-in equalizer.

- **Genre-driven EQ (v2.3.0).** The prompt classifies the song into one of ten tuning families (pop, City Pop/synth-pop, R&B, rock/metal, electronic/dance, hip-hop, jazz/classical/acoustic, ballad, indie/lo-fi, cinematic/ambient) with explicit per-band ranges; genre sets the baseline and mood/energy only fine-tune it. The panel shows which family the song is tuned by, and editing the genre invalidates the old curve.

- **One request per song.** Brief, curve, genre and token usage are remembered per song; replaying a song never calls the API again.
- **Web research (optional).** Before writing the brief, search public background/meaning with title + artist only (DuckDuckGo, Tavily, Serper, Bocha or your own SearXNG); off by default.
- **Taste learning.** Your 👍/👎 and manual sound changes are recorded and gently used for songs with a similar vibe.
- **Player-page entry.** A button at the right of the progress bar opens the AI EQ tab: current EQ, song tags, your rating, generate/A-B/undo.
- **Costs visible.** Per-song and total calls, tokens and estimated cost (your own prices).
- **Privacy.** Only song metadata, full lyrics (optional, ≤6000 chars) and a taste summary are sent to the provider you configure. No audio, account or device data. API key is stored in the OS credential store. No telemetry, no relay server.

Requires Folia desktop **0.7.22+** (Folium **1.7+**). MIT licensed.

**One-liner:** AI EQ reads the full lyrics, classifies the song's genre, and applies an EQ curve from that genre's tuning strategy — remembered per song, so replays never call the API again.

Install: drop the release zip into Folia's mods panel, enable the mod, confirm the permissions, then pick a provider and save your API key in the mod settings.
