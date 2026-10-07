# NoStream

**Scarica invece di streamare.** NoStream è un piccolo server self-hosted (Node.js +
ffmpeg) che prende gli stream trovati dagli addon Stremio/Nuvio e li trasforma in
**file scaricabili sul dispositivo**, così da guardarli senza connessione (in aereo, in
treno, all'estero).

Funziona in due modi:

- **come addon dentro [Nuvio](https://github.com/NuvioMedia/NuvioMobile)**: installi un
  URL di manifest e, cercando un titolo, compaiono le voci "⬇️ Scaricabile" /
  "🔄 Da convertire" che il **download nativo di Nuvio** scarica sul telefono;
- **come web app**: cerchi un titolo dal browser del dispositivo e il file finisce nella
  sua cartella Download.

> Già noto come NuvioDL / nuvio-offline. Per compatibilità restano invariati il nome
> dell'immagine Docker (`ghcr.io/katergaris/nuviodl`) e l'ID dell'addon
> (`org.nuvio-offline`).

> **Uso previsto**: scaricare solo contenuti per cui hai i diritti di visione. NoStream
> non fornisce contenuti propri: interroga gli addon che configuri tu ed effettua un
> proxy o un remux dello stream che quegli addon indicano.

---

## Indice

- [Come funziona](#come-funziona)
- [Requisiti](#requisiti)
- [Installazione](#installazione)
- [Primo avvio](#primo-avvio)
- [Usarlo dentro Nuvio](#usarlo-dentro-nuvio)
- [Esporlo fuori casa](#esporlo-fuori-casa)
- [Configurazione](#configurazione)
- [Aggiornamento](#aggiornamento)
- [Limiti noti](#limiti-noti)
- [Per sviluppatori](#per-sviluppatori)
- [Licenza](#licenza)

---

## Come funziona

```
 Nuvio (telefono)                 NoStream (tuo server)                 Addon sorgente
 ────────────────                 ─────────────────────                 ──────────────
 cerca un titolo  ── /stream ──▶  interroga in parallelo  ── /stream ──▶ addon Stremio
                                  gli addon configurati    ◀── stream ──
                  ◀── voci ⬇️/🔄 ─  (deduplica, ordina,
                                    legge le dimensioni)
 tocca "Scarica"  ── /api/download ─▶ file diretto: proxy con Range
                  ◀──── byte ──────  HLS (.m3u8): ffmpeg -> .ts temporaneo
```

**Ricerca degli stream.** Quando Nuvio chiede gli stream di un titolo, NoStream
interroga in parallelo tutti gli addon sorgente configurati (con un timeout regolabile),
risolve i link "scraper" che espongono solo una pagina (`externalUrl`) e restituisce a
Nuvio delle voci il cui `url` punta a NoStream stesso:

- i **link duplicati** proposti da più addon compaiono una volta sola;
- i **file diretti** (mp4/mkv) compaiono per primi come **⬇️ Scaricabile**, con la
  dimensione letta dalla fonte (Nuvio la mostra come badge);
- gli **HLS** compaiono sotto come **🔄 Da convertire**;
- torrent/magnet e provider non supportati vengono scartati.

**Download di un file diretto.** NoStream fa da proxy: inoltra i byte man mano che
arrivano, senza scriverli su disco, con gli header che la fonte richiede (`Referer`,
`User-Agent`, ...). L'header `Range` viene inoltrato, quindi un download interrotto
riprende dal punto raggiunto.

**Download di uno stream HLS (.m3u8).** Il download nativo di Nuvio non accetta HLS,
quindi NoStream lo converte:

1. sceglie la variante a qualità più alta della playlist;
2. avvia ffmpeg (video copiato, audio ricodificato in AAC) che scrive un **MPEG-TS
   temporaneo** su disco, a velocità piena e **indipendente dalla connessione** del
   telefono;
3. il telefono riceve il file mentre cresce; se si disconnette e riprende con `Range`
   (su Android 14+ Nuvio riapre la connessione a ogni cambio di rete), il download
   continua dal punto raggiunto;
4. a conversione finita il file si serve con dimensione esatta (Nuvio mostra la
   percentuale);
5. il file temporaneo viene **cancellato 2 minuti dopo che il telefono l'ha ricevuto per
   intero** (6 ore dopo l'ultimo accesso se il download non viene mai completato, e
   comunque a ogni riavvio).

ffmpeg usa un timeout di 15 s per richiesta, riconnessione e fino a 10 tentativi per
segmento, perché alcuni CDN lasciano ogni tanto connessioni appese. Se la conversione
fallisce a metà, NoStream interrompe la connessione invece di chiuderla normalmente:
così Nuvio segna il download come fallito (e si può riprovare) invece di salvare un file
troncato come completato.

Perché `.ts` e non `.mkv`: su un file ancora in scrittura ffmpeg non può scrivere
l'indice del MKV, e ExoPlayer (il player di Nuvio su Android) non permette di navigare
in un MKV senza indice; in un `.ts` invece sì.

### Provider "scraper" supportati

Alcuni addon "scraper" non danno un URL di stream ma una pagina di "extractor"
(`externalUrl`). NoStream la risolve lato server per questi provider:

| Provider | Sito | Risultato |
|---|---|---|
| `gx` | MixDrop | file mp4 diretto |
| `css` | StreamingCommunity / vixsrc | HLS |
| `dd` | Altadefinizione | di norma HLS |
| `sp3` | StreamHG | di norma HLS |
| `voe` | VOE | di norma HLS |

Il tipo effettivo (file diretto o HLS) viene comunque rilevato al momento del download.
Gli extractor dipendono dai siti di origine e possono smettere di funzionare quando
questi cambiano: le voci dei provider non supportati non vengono mostrate.

---

## Requisiti

- Un server sempre acceso nella tua rete: NAS, Raspberry Pi, mini PC, VM
  (immagine Docker disponibile per **amd64** e **arm64**).
- Docker, **oppure** Node.js ≥ 18 + ffmpeg.
- Una **API key TMDB** gratuita (per titoli e ricerca):
  1. crea un account su <https://www.themoviedb.org/signup>;
  2. vai su <https://www.themoviedb.org/settings/api> e richiedi una chiave
     "Developer" (uso non commerciale, gratuita);
  3. copia la "API Key (v3 auth)".
- Uno o più **addon Stremio sorgente** con stream HTTP (non torrent).
- Spazio su disco temporaneo per gli HLS: circa 200 MB–2 GB per contenuto in corso di
  download, liberato da solo.

---

## Installazione

### Docker (consigliato)

L'immagine è pubblica e già pronta, non serve compilare nulla.

```bash
mkdir nostream && cd nostream
# config.json deve esistere come file PRIMA dell'avvio, altrimenti Docker crea una cartella
echo '{}' > config.json

docker run -d --name nostream --restart unless-stopped \
  -p 4321:4321 \
  -v "$(pwd)/config.json:/app/config.json" \
  ghcr.io/katergaris/nuviodl:latest
```

### Docker Compose

```bash
git clone https://github.com/katergaris/NoStream.git
cd NoStream
cp config.example.json config.json
docker compose up -d
```

Il [`docker-compose.yml`](docker-compose.yml) usa l'immagine pubblicata e monta solo
`config.json`, così impostazioni e lista addon sopravvivono a riavvii e aggiornamenti.
Per compilare l'immagine dal sorgente usa `docker compose up -d --build` dopo aver
decommentato la riga `build: .`.

### CasaOS / ZimaOS

Dall'interfaccia: **App Store → Custom Install** (o "Installa app personalizzata"),
incolla il contenuto di [`docker-compose.yml`](docker-compose.yml) e imposta come
sorgente del volume un file `config.json` già creato in una cartella dei dati (es.
`/DATA/AppData/nostream/config.json`).

### Da sorgente, senza Docker

```bash
git clone https://github.com/katergaris/NoStream.git
cd NoStream
npm install --omit=dev
cp config.example.json config.json
node server.js
```

`ffmpeg -version` deve funzionare nel terminale (serve per gli stream HLS).

---

## Primo avvio

1. Apri `http://<ip-del-server>:4321` dal browser.
2. Scheda **Impostazioni**:
   - incolla la **TMDB API Key** e salva;
   - in **Addon Stremio** aggiungi gli addon sorgente (nome + URL del `manifest.json`).
3. Scheda **Cerca**: cerca un titolo, scegli stagione/episodio, premi su uno stream per
   scaricarlo nel browser.

Tutte le impostazioni finiscono in `config.json`: nessun bisogno di modificarlo a mano.

---

## Usarlo dentro Nuvio

1. In Nuvio apri le impostazioni degli addon e installa:
   ```
   http://<ip-del-server>:4321/manifest.json
   ```
2. Cerca un titolo come al solito: tra gli stream compaiono le voci di **NoStream**.
3. **Tieni premuto** su una voce e scegli **Scarica**: il file viene
   scaricato dal download nativo di Nuvio.
4. I download si trovano in **Libreria → icona di download** in alto a destra.

Consigli:

- preferisci le voci **⬇️ Scaricabile**: scaricano a velocità piena, con dimensione e
  percentuale;
- le voci **🔄 Da convertire** funzionano, ma la dimensione è nota solo a conversione
  finita;
- se hai gli stessi addon sorgente installati anche in Nuvio, vedrai sia i loro stream
  (per guardare in streaming) sia quelli di NoStream (per scaricare).

---

## Esporlo fuori casa

NoStream **non ha autenticazione**: chiunque raggiunga la porta può cercare e
scaricare. Non esporlo direttamente su Internet. Alternative sicure:

- **VPN** (Tailscale, WireGuard, ZeroTier): il telefono raggiunge il server come se
  fosse in casa;
- **reverse proxy con autenticazione** (Nginx, Traefik, Caddy con Basic Auth).

Dietro un reverse proxy **HTTPS** (incluso `tailscale serve`), NoStream genera i link di
download in `https://` leggendo `X-Forwarded-Proto` (per gli host `*.ts.net` lo fa in
ogni caso). Assicurati che il proxy inoltri questo header, altrimenti Nuvio riceverebbe
link `http://` verso una porta HTTPS e il download fallirebbe con errore 400.

---

## Configurazione

`config.json` (modificabile anche dalla scheda Impostazioni):

| Campo | Default | Descrizione |
|---|---|---|
| `tmdbApiKey` | `""` | API key v3 di TMDB |
| `language` | `it-IT` | Lingua di titoli e metadati (`it-IT`, `en-US`) |
| `port` | `4321` | Porta HTTP |
| `concurrentDownloads` | `2` | Massimo di conversioni HLS contemporanee (le riprese dello stesso download non contano; i file diretti non hanno limite) |
| `addonTimeoutMs` | `60000` | Tempo massimo di attesa per ogni addon sorgente: gli addon più lenti vengono saltati. NoStream risponde a Nuvio solo quando tutti gli addon hanno risposto o sono scaduti, quindi abbassarlo (es. `15000`) rende la lista più veloce |
| `addons` | `[]` | Addon sorgente (`name`, `manifestUrl`), gestibili dalla UI |

Variabile d'ambiente: `CONFIG_PATH` per usare un `config.json` in un altro percorso.

---

## Aggiornamento

```bash
docker pull ghcr.io/katergaris/nuviodl:latest
docker compose up -d        # oppure: docker rm -f nostream && docker run ... (come sopra)
```

Su CasaOS/ZimaOS il pulsante di aggiornamento non sempre ricrea il container quando
cambia solo l'immagine dietro `latest`: dopo il `docker pull` riapplica il compose
dell'app (o rimuovi e reinstalla l'app mantenendo lo stesso `config.json`).

L'immagine viene ricompilata da GitHub Actions a ogni push su `main`.

---

## Limiti noti

- **Nessuna autenticazione integrata** (vedi [Esporlo fuori casa](#esporlo-fuori-casa)).
- **Torrent/magnet non supportati**: servirebbe un client BitTorrent.
- **HLS**: dimensione e percentuale compaiono solo a conversione finita; durante la
  conversione Nuvio mostra i MB ricevuti.
- **CDN legati all'IP**: alcune fonti firmano il link per l'IP di chi lo ha richiesto.
  Per i file diretti, se la fonte risponde 403 NoStream reindirizza il client alla
  fonte; per gli HLS non c'è un'alternativa.
- **La lista arriva tutta insieme**: il protocollo degli addon prevede una sola risposta
  per richiesta, quindi Nuvio mostra le voci di NoStream quando l'addon sorgente più
  lento ha risposto (o è scaduto il timeout).
- **Android 14+**: Nuvio può riaprire spesso la connessione del download o metterlo in
  pausa; grazie alla ripresa con `Range` basta premere "riprendi" e continua dal punto
  raggiunto.
- **Web app**: va aperta dal browser dello stesso dispositivo su cui vuoi il file.

---

## Per sviluppatori

### Struttura

```
server.js          route Express: web UI, API, addon Stremio (/manifest.json, /stream)
src/config.js      caricamento/scrittura di config.json
src/addons.js      ricerca TMDB e interrogazione degli addon sorgente
src/extractor.js   risoluzione degli externalUrl "scraper" (css, dd, gx, sp3, voe)
src/streamer.js    download: proxy con Range per i file diretti, conversione HLS su disco
public/            frontend statico (HTML/CSS/JS vanilla)
```

### API

| Metodo | Path | Descrizione |
|---|---|---|
| GET | `/manifest.json` | Manifest dell'addon Stremio/Nuvio |
| GET | `/stream/:type/:id.json` | Stream scaricabili per un titolo (protocollo Stremio) |
| GET | `/api/download/:data/:filename` | Download (`data` = JSON in base64url con `sourceUrl`/`externalUrl`, `headers`, `title`; `filename` è solo cosmetico, Nuvio ne usa l'estensione). Supporta `Range` |
| GET | `/api/download?data=` | Come sopra, senza estensione nel path (usato dalla web UI) |
| GET | `/api/search?query=` | Ricerca titoli su TMDB |
| GET | `/api/seasons/:tmdbId` | Stagioni di una serie |
| GET | `/api/episodes/:tmdbId/:season` | Episodi di una stagione |
| GET | `/api/streams?tmdbId=&type=&season=&episode=` | Stream trovati dagli addon (web UI) |
| GET/POST | `/api/settings` | Lettura/modifica delle impostazioni |
| GET/POST | `/api/addons` | Lista/aggiunta addon sorgente (`name`, `manifestUrl`) |
| DELETE | `/api/addons/:id` | Rimozione di un addon sorgente |

### Log utili

`docker logs nostream` mostra ogni richiesta e, per gli HLS, `HLS completato`,
`HLS fallito` (con la coda del log di ffmpeg) e `HLS rimosso dal disco`.

### Contribuire

Issue e pull request sono benvenute, in particolare per nuovi extractor e per i
provider che smettono di funzionare. Per provare in locale:

```bash
CONFIG_PATH=./config.json node server.js
```

---

## Licenza

[MIT](LICENSE) © 2026 katergaris. Il software è fornito "così com'è", senza garanzie:
chi lo installa è responsabile dell'uso che ne fa e dei contenuti che scarica.
