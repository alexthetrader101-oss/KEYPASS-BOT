const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

const userState = {};

async function sendMessage(chatId, text) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text: text
  });
}

function cleanupOldPasses() {
  const tmpDir = '/tmp';
  const files = fs.readdirSync(tmpDir).filter(f => f.startsWith('pass_') && f.endsWith('.pkpass'));
  const now = Date.now();
  for (const file of files) {
    const filePath = path.join(tmpDir, file);
    const stat = fs.statSync(filePath);
    if (now - stat.mtimeMs > 24 * 60 * 60 * 1000) {
      fs.unlinkSync(filePath);
      console.log(`Deleted old pass: ${file}`);
    }
  }
}
setInterval(cleanupOldPasses, 60 * 60 * 1000);

const SCRAPE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive'
};

function detectSite(url) {
  if (url.includes('lu.ma') || url.includes('luma.com')) return 'luma';
  if (url.includes('eventbrite.com')) return 'eventbrite';
  if (url.includes('dice.fm')) return 'dice';
  if (url.includes('feverup.com') || url.includes('fever.com')) return 'fever';
  if (url.includes('amctheatres.com')) return 'amc';
  if (url.includes('cinemark.com')) return 'cinemark';
  return null;
}

function extractURLs(text) {
  const matches = text.match(/https?:\/\/[^\s,]+/g);
  if (!matches) return [];
  return matches.map(u => u.replace(/[.,!?]+$/, ''));
}

function colorForSite(site) {
  const map = {
    luma: 'blue',
    eventbrite: 'dark',
    dice: 'purple',
    fever: 'dark',
    amc: 'red',
    cinemark: 'red'
  };
  return map[site] || 'dark';
}

function safeVal(val, fallback = 'N/A') {
  if (val === null || val === undefined) return fallback;
  const str = String(val).trim();
  return str.length > 0 ? str : fallback;
}

function generateTicketNumber() {
  return 'TKT-' + Math.random().toString(36).toUpperCase().slice(2, 7);
}
function generateSection() {
  return ['GA', 'FLOOR', 'SEC A', 'SEC B', 'VIP'][Math.floor(Math.random() * 5)];
}
function generateGate() {
  return ['GATE 1', 'GATE 2', 'GATE 3', 'MAIN', 'SIDE'][Math.floor(Math.random() * 5)];
}
function generateRow() {
  return ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'][Math.floor(Math.random() * 8)];
}
function generateSeat() {
  return String(Math.floor(Math.random() * 30) + 1);
}
function generateAuditorium() {
  return 'AUDITORIUM ' + String(Math.floor(Math.random() * 20) + 1);
}

function cleanName(name) {
  if (!name) return 'Event';
  return name
    .replace(/\s*[\|·—]\s*(Partiful|Luma|Dice|Eventbrite|Fever|AMC|Cinemark).*$/i, '')
    .replace(/\s*[Tt]ickets.*$/, '')
    .trim()
    .slice(0, 100);
}

async function scrapeLuma(url) {
  const slug = url.replace(/\?.*$/, '').replace(/,+$/, '').split('/').pop();
  try {
    const { data } = await axios.get(`https://api.lu.ma/public/v1/event/get?url_slug=${slug}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    });
    const event = data.event;
    const name = cleanName(event.name);
    const date = event.start_at
      ? new Date(event.start_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
      : 'See event page';
    const time = event.start_at
      ? new Date(event.start_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      : 'See event page';
    const location = (event.location_summary || (event.geo_address_info && event.geo_address_info.full_address) || 'See event page').slice(0, 100);
    const description = (event.description || 'N/A').slice(0, 200);
    return { name, date, time, location, description };
  } catch (e) {
    const { data } = await axios.get(url.replace(/,+$/, ''), { headers: SCRAPE_HEADERS });
    const $ = cheerio.load(data);
    const name = cleanName($('meta[property="og:title"]').attr('content') || $('h1').first().text().trim() || 'Event');
    let date = 'See event page', time = 'See event page';
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const json = JSON.parse($(el).html());
        if (json['@type'] === 'Event' && json.startDate) {
          const d = new Date(json.startDate);
          date = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
          time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        }
      } catch (err) {}
    });
    const location = ($('meta[property="event:location"]').attr('content') || 'See event page').slice(0, 100);
    const description = ($('meta[name="description"]').attr('content') || 'N/A').slice(0, 200);
    return { name, date, time, location, description };
  }
}

async function scrapeEventbrite(url) {
  const { data } = await axios.get(url, { headers: SCRAPE_HEADERS });
  const $ = cheerio.load(data);
  const name = cleanName($('meta[property="og:title"]').attr('content') || $('h1').first().text().trim() || 'Event');
  let date = 'See event page', time = 'See event page', location = 'See event page';
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html());
      if (json['@type'] === 'Event') {
        if (json.startDate) {
          const d = new Date(json.startDate);
          date = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
          time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        }
        location = (json.location && json.location.name) || (json.location && json.location.address && json.location.address.streetAddress) || 'See event page';
      }
    } catch (e) {}
  });
  const description = ($('meta[property="og:description"]').attr('content') || 'N/A').slice(0, 200);
  return { name, date, time, location: location.slice(0, 100), description };
}

async function scrapeDice(url) {
  const { data } = await axios.get(url, { headers: SCRAPE_HEADERS });
  const $ = cheerio.load(data);
  const name = cleanName($('meta[property="og:title"]').attr('content') || $('h1').first().text().trim() || 'Event');
  let date = 'See event page', time = 'See event page', location = 'See event page';
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html());
      if (json['@type'] === 'Event') {
        if (json.startDate) {
          const d = new Date(json.startDate);
          date = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
          time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        }
        location = (json.location && json.location.name) || 'See event page';
      }
    } catch (e) {}
  });
  const description = ($('meta[name="description"]').attr('content') || 'N/A').slice(0, 200);
  return { name, date, time, location: location.slice(0, 100), description };
}

async function scrapeFever(url) {
  const { data } = await axios.get(url, { headers: SCRAPE_HEADERS });
  const $ = cheerio.load(data);
  const name = cleanName($('meta[property="og:title"]').attr('content') || $('h1').first().text().trim() || 'Event');
  let date = 'See event page', time = 'See event page', location = 'See event page';
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html());
      const event = Array.isArray(json) ? json.find(j => j['@type'] === 'Event') : (json['@type'] === 'Event' ? json : null);
      if (event) {
        if (event.startDate) {
          const d = new Date(event.startDate);
          date = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
          time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        }
        location = (event.location && event.location.name) || (event.location && event.location.address && event.location.address.streetAddress) || 'See event page';
      }
    } catch (e) {}
  });
  if (date === 'See event page') {
    const ogDate = $('meta[property="event:start_time"]').attr('content') || $('meta[name="date"]').attr('content');
    if (ogDate) {
      const d = new Date(ogDate);
      date = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    }
  }
  if (location === 'See event page') {
    location = ($('meta[property="og:street-address"]').attr('content') || $('meta[property="event:location"]').attr('content') || 'See event page').slice(0, 100);
  }
  const description = ($('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || 'N/A').slice(0, 200);
  return { name, date, time, location: location.slice(0, 100), description };
}

async function scrapeAMC(url) {
  const { data } = await axios.get(url, { headers: SCRAPE_HEADERS });
  const $ = cheerio.load(data);

  let name = $('meta[property="og:title"]').attr('content') || $('h1').first().text().trim();
  if (!name || name.toLowerCase().includes('amc theatres') || name.toLowerCase() === 'amc') {
    const urlMatch = url.match(/\/movies\/([^\/\?]+)/i);
    if (urlMatch) {
      name = urlMatch[1]
        .replace(/-\d+$/, '')
        .replace(/-/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
    }
  }
  name = cleanName(name || 'Movie');

  let date = 'See movie page', time = 'See movie page', location = 'AMC Theatres', rating = '', runtime = '';
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html());
      const item = Array.isArray(json) ? json.find(j => j['@type'] === 'Movie' || j['@type'] === 'ScreeningEvent') : json;
      if (item) {
        if (item.startDate) {
          const d = new Date(item.startDate);
          date = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
          time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        }
        location = (item.location && item.location.name) || 'AMC Theatres';
        rating = item.contentRating || '';
        if (item.duration) {
          const match = item.duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
          if (match) {
            const hrs = match[1] ? `${match[1]}h ` : '';
            const mins = match[2] ? `${match[2]}m` : '';
            runtime = (hrs + mins).trim();
          }
        }
      }
    } catch (e) {}
  });
  if (location === 'AMC Theatres') {
    const pageTitle = $('title').text();
    const theaterMatch = pageTitle.match(/at\s+(.+?)(\s*[-|]|$)/i);
    if (theaterMatch) location = theaterMatch[1].trim().slice(0, 100);
  }
  const ratingRuntime = [rating, runtime].filter(Boolean).join(' · ') || 'N/A';
  const description = ($('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || 'N/A').slice(0, 200);
  return { name, date, time, location: location.slice(0, 100), description, ratingRuntime };
}

async function scrapeCinemark(url) {
  const { data } = await axios.get(url, { headers: SCRAPE_HEADERS });
  const $ = cheerio.load(data);

  let name = $('meta[property="og:title"]').attr('content') || $('h1').first().text().trim();
  if (!name || name.toLowerCase().includes('cinemark')) {
    const urlMatch = url.match(/\/movies\/([^\/\?]+)/i);
    if (urlMatch) {
      name = urlMatch[1]
        .replace(/-\d+$/, '')
        .replace(/-/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
    }
  }
  name = cleanName(name || 'Movie');

  let date = 'See movie page', time = 'See movie page', location = 'Cinemark', rating = '', runtime = '';
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html());
      const item = Array.isArray(json) ? json.find(j => j['@type'] === 'Movie' || j['@type'] === 'ScreeningEvent') : json;
      if (item) {
        if (item.startDate) {
          const d = new Date(item.startDate);
          date = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
          time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        }
        location = (item.location && item.location.name) || 'Cinemark';
        rating = item.contentRating || '';
        if (item.duration) {
          const match = item.duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
          if (match) {
            const hrs = match[1] ? `${match[1]}h ` : '';
            const mins = match[2] ? `${match[2]}m` : '';
            runtime = (hrs + mins).trim();
          }
        }
      }
    } catch (e) {}
  });
  if (location === 'Cinemark') {
    const theaterMatch = url.match(/\/theatre\/([^\/]+)/i);
    if (theaterMatch) location = theaterMatch[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).slice(0, 100);
  }
  const ratingRuntime = [rating, runtime].filter(Boolean).join(' · ') || 'N/A';
  const description = ($('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || 'N/A').slice(0, 200);
  return { name, date, time, location: location.slice(0, 100), description, ratingRuntime };
}

async function scrapeByUrl(url) {
  const site = detectSite(url);
  if (site === 'luma') return { eventData: await scrapeLuma(url), site };
  if (site === 'eventbrite') return { eventData: await scrapeEventbrite(url), site };
  if (site === 'dice') return { eventData: await scrapeDice(url), site };
  if (site === 'fever') return { eventData: await scrapeFever(url), site };
  if (site === 'amc') return { eventData: await scrapeAMC(url), site };
  if (site === 'cinemark') return { eventData: await scrapeCinemark(url), site };
  return null;
}

async function generatePass(eventData, eventUrl, site, passholder = null) {
  const ticketNumber = generateTicketNumber();
  const section = generateSection();
  const gate = generateGate();
  const row = generateRow();
  const seat = generateSeat();
  const auditorium = generateAuditorium();
  const isMovie = site === 'amc' || site === 'cinemark';
  const color = colorForSite(site);
  const passholderVal = safeVal(passholder ? passholder.toUpperCase() : null, 'N/A');

  const passPayload = {
    barcodeValue: eventUrl,
    barcodeFormat: 'QR',
    logoText: 'KEYPASS',
    description: safeVal(eventData.name, 'Event'),
    organizationName: 'Keypass',
    colorPreset: color,
    headerFields: [
      { label: 'DATE', value: safeVal(eventData.date, 'See page') },
      { label: 'NAME', value: passholderVal }
    ],
    primaryFields: [
      { label: isMovie ? 'FILM' : 'EVENT', value: safeVal(eventData.name, 'Event') }
    ],
    secondaryFields: isMovie
      ? [
          { label: 'AUDITORIUM', value: safeVal(auditorium) },
          { label: 'ROW', value: safeVal(row) },
          { label: 'SEAT', value: safeVal(seat) }
        ]
      : [
          { label: 'SECTION', value: safeVal(section) },
          { label: 'ROW', value: safeVal(row) },
          { label: 'SEAT', value: safeVal(seat) }
        ],
    auxiliaryFields: isMovie
      ? [
          { label: 'TIME', value: safeVal(eventData.time, 'See page') },
          { label: 'THEATER', value: safeVal(eventData.location, 'See page') },
          { label: 'TICKET', value: safeVal(ticketNumber) }
        ]
      : [
          { label: 'TIME', value: safeVal(eventData.time, 'Doors Open') },
          { label: 'GATE', value: safeVal(gate) },
          { label: 'TICKET', value: safeVal(ticketNumber) }
        ],
    backFields: isMovie
      ? [
          { label: 'TICKET NUMBER', value: safeVal(ticketNumber) },
          { label: 'PASSHOLDER', value: passholderVal },
          { label: 'FILM', value: safeVal(eventData.name, 'Movie') },
          { label: 'DATE', value: safeVal(eventData.date, 'See page') },
          { label: 'TIME', value: safeVal(eventData.time, 'See page') },
          { label: 'THEATER', value: safeVal(eventData.location, 'See page') },
          { label: 'AUDITORIUM', value: safeVal(auditorium) },
          { label: 'ROW', value: safeVal(row) },
          { label: 'SEAT', value: safeVal(seat) },
          { label: 'RATING / RUNTIME', value: safeVal(eventData.ratingRuntime, 'N/A') }
        ]
      : [
          { label: 'TICKET NUMBER', value: safeVal(ticketNumber) },
          { label: 'PASSHOLDER', value: passholderVal },
          { label: 'EVENT', value: safeVal(eventData.name, 'Event') },
          { label: 'DATE', value: safeVal(eventData.date, 'See page') },
          { label: 'TIME', value: safeVal(eventData.time, 'See page') },
          { label: 'LOCATION', value: safeVal(eventData.location, 'See page') },
          { label: 'SECTION', value: safeVal(section) },
          { label: 'ROW', value: safeVal(row) },
          { label: 'SEAT', value: safeVal(seat) },
          { label: 'GATE', value: safeVal(gate) }
        ]
  };

  let response;
  try {
    response = await axios.post(
      'https://api.walletwallet.dev/api/pkpass',
      passPayload,
      {
        headers: {
          Authorization: `Bearer ${process.env.WALLETWALLET_API_KEY}`,
          'Content-Type': 'application/json'
        },
        responseType: 'arraybuffer'
      }
    );
  } catch (err) {
    if (err.response) {
      const errorBody = Buffer.from(err.response.data).toString('utf8');
      console.error('WalletWallet 400 error body:', errorBody);
      throw new Error(`WalletWallet rejected the payload: ${errorBody}`);
    }
    throw err;
  }

  const fileName = `pass_${Date.now()}.pkpass`;
  const filePath = path.join('/tmp', fileName);
  fs.writeFileSync(filePath, response.data);

  const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;

  return {
    passUrl: `${baseUrl}/passes/${fileName}`,
    ticketNumber, section, row, seat, gate, auditorium, isMovie
  };
}

app.get('/passes/:filename', (req, res) => {
  const filePath = path.join('/tmp', req.params.filename);
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', 'application/vnd.apple.pkpass');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.filename}"`);
    res.sendFile(filePath);
  } else {
    res.status(404).send('Pass not found');
  }
});

app.post('/webhook/inbound', async (req, res) => {
  res.sendStatus(200);
  const message = req.body.message;
  if (!message || !message.text) return;

  const chatId = message.chat.id;
  const incomingMsg = message.text.trim();

  console.log(`Received from ${chatId}: ${incomingMsg}`);

  if (incomingMsg === '/last') {
    const last = userState[chatId]?.lastPassUrl;
    if (last) {
      await sendMessage(chatId, `🎟️ Here's your last pass:\n${last}`);
    } else {
      await sendMessage(chatId, `No pass generated yet in this session.`);
    }
    return;
  }

  if (incomingMsg === '/help') {
    await sendMessage(chatId,
      `🎟️ Keypass Bot\n\nSupported sites:\n• lu.ma\n• eventbrite.com\n• dice.fm\n• feverup.com\n• amctheatres.com\n• cinemark.com\n\nSend one or more URLs to generate passes.\nSend /last to resend your last pass.`
    );
    return;
  }

  if (userState[chatId]?.waitingForName) {
    const name = incomingMsg.toLowerCase() === 'skip' ? null : incomingMsg;
    const pending = userState[chatId].pendingPasses;
    userState[chatId].waitingForName = false;
    userState[chatId].pendingPasses = null;

    await sendMessage(chatId, `Generating ${pending.length} pass${pending.length > 1 ? 'es' : ''}... 🎟️`);

    for (const { eventData, url, site } of pending) {
      try {
        const { passUrl, section, row, seat, gate, auditorium, ticketNumber, isMovie } = await generatePass(eventData, url, site, name);
        userState[chatId].lastPassUrl = passUrl;

        const details = isMovie
          ? `AUDITORIUM: ${auditorium} | ROW: ${row} | SEAT: ${seat} | TICKET: ${ticketNumber}`
          : `SECTION: ${section} | ROW: ${row} | SEAT: ${seat} | GATE: ${gate} | TICKET: ${ticketNumber}`;

        await sendMessage(chatId, `✅ ${eventData.name}\n${details}\n\nTap to add to Apple Wallet:\n${passUrl}`);
      } catch (err) {
        console.error(err);
        await sendMessage(chatId, `❌ Failed to generate pass for ${url}: ${err.message}`);
      }
    }
    return;
  }

  const urls = extractURLs(incomingMsg);
  const validUrls = urls.filter(u => detectSite(u));

  if (validUrls.length === 0) return;

  await sendMessage(chatId, `Fetching details for ${validUrls.length} link${validUrls.length > 1 ? 's' : ''}...`);

  const results = [];
  for (const url of validUrls) {
    try {
      const result = await scrapeByUrl(url);
      if (result) results.push({ ...result, url });
    } catch (err) {
      await sendMessage(chatId, `⚠️ Couldn't scrape ${url}: ${err.message}`);
    }
  }

  if (results.length === 0) return;

  let preview = `Here's what I found:\n\n`;
  for (const { eventData, site } of results) {
    const isMovie = site === 'amc' || site === 'cinemark';
    preview += `🎟️ ${eventData.name}\n`;
    preview += `📅 ${eventData.date}${eventData.time && eventData.time !== 'See event page' && eventData.time !== 'See movie page' ? ' @ ' + eventData.time : ''}\n`;
    preview += `📍 ${eventData.location}\n`;
    if (isMovie && eventData.ratingRuntime && eventData.ratingRuntime !== 'N/A') preview += `🎬 ${eventData.ratingRuntime}\n`;
    preview += `\n`;
  }

  preview += `What name should go on the pass? Reply with a name or "skip"`;

  await sendMessage(chatId, preview);

  userState[chatId] = {
    waitingForName: true,
    pendingPasses: results
  };
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Keypass bot running on port ${PORT}`);
  const webhookUrl = `${process.env.RENDER_EXTERNAL_URL}/webhook/inbound`;
  try {
    await axios.post(`${TELEGRAM_API}/setWebhook`, { url: webhookUrl });
    console.log(`Telegram webhook set to ${webhookUrl}`);
  } catch (e) {
    console.error('Failed to set Telegram webhook:', e.message);
  }
});
