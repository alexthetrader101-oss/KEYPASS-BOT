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
  await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text: text });
}

async function sendInlineKeyboard(chatId, text, buttons) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId, text: text,
    reply_markup: { inline_keyboard: buttons }
  });
}

async function answerCallbackQuery(callbackQueryId) {
  await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, { callback_query_id: callbackQueryId });
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

const MOVIE_SITES = ['amc', 'cinemark'];

function detectSite(url) {
  if (url.includes('lu.ma') || url.includes('luma.com')) return 'luma';
  if (url.includes('eventbrite.com')) return 'eventbrite';
  if (url.includes('dice.fm')) return 'dice';
  if (url.includes('feverup.com') || url.includes('fever.com')) return 'fever';
  if (url.includes('amctheatres.com')) return 'amc';
  if (url.includes('cinemark.com')) return 'cinemark';
  return null;
}

function isMovieSite(site) { return MOVIE_SITES.includes(site); }

function extractURLs(text) {
  const matches = text.match(/https?:\/\/[^\s,]+/g);
  if (!matches) return [];
  return matches.map(u => u.replace(/[.,!?]+$/, ''));
}

function colorForSite(site) {
  const map = { luma: 'blue', eventbrite: 'dark', dice: 'purple', fever: 'dark', amc: 'red', cinemark: 'red' };
  return map[site] || 'dark';
}

function safeVal(val, fallback = 'N/A') {
  if (val === null || val === undefined) return fallback;
  const str = String(val).trim();
  return str.length > 0 ? str : fallback;
}

function generateMovieSeat() {
  const audNum = Math.floor(Math.random() * 20) + 1;
  const row = ['A','B','C','D','E','F','G','H','J','K'][Math.floor(Math.random() * 10)];
  const seat = Math.floor(Math.random() * 20) + 1;
  return { auditorium: String(audNum), row, seat: String(seat) };
}

function generateEventSeat() {
  const sections = ['GA', 'FLOOR', 'PIT', 'SEC 100', 'SEC 200', 'VIP', 'BALCONY', 'MEZZANINE'];
  const gates = ['GATE A', 'GATE B', 'GATE C', 'MAIN ENTRANCE', 'NORTH GATE', 'SOUTH GATE'];
  const rows = ['A','B','C','D','E','F','G','H','J','K','L','M'];
  return {
    section: sections[Math.floor(Math.random() * sections.length)],
    gate: gates[Math.floor(Math.random() * gates.length)],
    row: rows[Math.floor(Math.random() * rows.length)],
    seat: String(Math.floor(Math.random() * 30) + 1)
  };
}

function getExpirationDate(eventDateStr) {
  if (!eventDateStr) return null;
  try {
    const d = new Date(eventDateStr);
    if (isNaN(d.getTime()) || d.getFullYear() < 2020) return null;
    d.setDate(d.getDate() + 1);
    return d.toISOString();
  } catch (e) {}
  return null;
}

function cleanName(name) {
  if (!name) return 'Event';
  return name
    .replace(/\s*[\|·—]\s*(Partiful|Luma|Dice|Eventbrite|Fever|AMC|Cinemark).*$/i, '')
    .replace(/\s*[Tt]ickets.*$/, '')
    .replace(/\s*[-–]\s*Buy.*$/i, '')
    .trim().slice(0, 100);
}

async function scrapeLuma(url) {
  const slug = url.replace(/\?.*$/, '').replace(/,+$/, '').split('/').pop();
  try {
    const { data } = await axios.get(`https://api.lu.ma/public/v1/event/get?url_slug=${slug}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    });
    const event = data.event;
    const name = cleanName(event.name);
    const date = event.start_at ? new Date(event.start_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : 'See event page';
    const time = event.start_at ? new Date(event.start_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : 'See event page';
    const location = (event.location_summary || (event.geo_address_info && event.geo_address_info.full_address) || 'See event page').slice(0, 100);
    const description = (event.description || 'N/A').slice(0, 200);
    const rawDate = event.start_at || null;
    return { name, date, time, location, description, rawDate };
  } catch (e) {
    const { data } = await axios.get(url.replace(/,+$/, ''), { headers: SCRAPE_HEADERS });
    const $ = cheerio.load(data);
    const name = cleanName($('meta[property="og:title"]').attr('content') || $('h1').first().text().trim() || 'Event');
    let date = 'See event page', time = 'See event page', rawDate = null;
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const json = JSON.parse($(el).html());
        if (json['@type'] === 'Event' && json.startDate) {
          rawDate = json.startDate;
          const d = new Date(json.startDate);
          date = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
          time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        }
      } catch (err) {}
    });
    const location = ($('meta[property="event:location"]').attr('content') || 'See event page').slice(0, 100);
    const description = ($('meta[name="description"]').attr('content') || 'N/A').slice(0, 200);
    return { name, date, time, location, description, rawDate };
  }
}

async function scrapeEventbrite(url) {
  const { data } = await axios.get(url, { headers: SCRAPE_HEADERS });
  const $ = cheerio.load(data);
  const name = cleanName($('meta[property="og:title"]').attr('content') || $('h1').first().text().trim() || 'Event');
  let date = 'See event page', time = 'See event page', location = 'See event page', rawDate = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html());
      if (json['@type'] === 'Event') {
        if (json.startDate) {
          rawDate = json.startDate;
          const d = new Date(json.startDate);
          date = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
          time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        }
        location = (json.location && json.location.name) || (json.location && json.location.address && json.location.address.streetAddress) || 'See event page';
      }
    } catch (e) {}
  });
  const description = ($('meta[property="og:description"]').attr('content') || 'N/A').slice(0, 200);
  return { name, date, time, location: location.slice(0, 100), description, rawDate };
}

async function scrapeDice(url) {
  const { data } = await axios.get(url, { headers: SCRAPE_HEADERS });
  const $ = cheerio.load(data);
  const name = cleanName($('meta[property="og:title"]').attr('content') || $('h1').first().text().trim() || 'Event');
  let date = 'See event page', time = 'See event page', location = 'See event page', rawDate = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html());
      if (json['@type'] === 'Event') {
        if (json.startDate) {
          rawDate = json.startDate;
          const d = new Date(json.startDate);
          date = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
          time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        }
        location = (json.location && json.location.name) || 'See event page';
      }
    } catch (e) {}
  });
  const description = ($('meta[name="description"]').attr('content') || 'N/A').slice(0, 200);
  return { name, date, time, location: location.slice(0, 100), description, rawDate };
}

async function scrapeFever(url) {
  const { data } = await axios.get(url, { headers: SCRAPE_HEADERS });
  const $ = cheerio.load(data);
  const name = cleanName($('meta[property="og:title"]').attr('content') || $('h1').first().text().trim() || 'Event');
  let date = 'See event page', time = 'See event page', location = 'See event page', rawDate = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html());
      const event = Array.isArray(json) ? json.find(j => j['@type'] === 'Event') : (json['@type'] === 'Event' ? json : null);
      if (event) {
        if (event.startDate) {
          rawDate = event.startDate;
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
      rawDate = ogDate;
      const d = new Date(ogDate);
      date = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    }
  }
  if (location === 'See event page') {
    location = ($('meta[property="og:street-address"]').attr('content') || $('meta[property="event:location"]').attr('content') || 'See event page').slice(0, 100);
  }
  const description = ($('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || 'N/A').slice(0, 200);
  return { name, date, time, location: location.slice(0, 100), description, rawDate };
}

async function scrapeAMC(url) {
  const { data } = await axios.get(url, { headers: SCRAPE_HEADERS });
  const $ = cheerio.load(data);
  let name = $('meta[property="og:title"]').attr('content') || $('h1').first().text().trim();
  if (!name || name.toLowerCase().includes('amc theatres') || name.toLowerCase() === 'amc') {
    const urlMatch = url.match(/\/movies\/([^\/\?]+)/i);
    if (urlMatch) name = urlMatch[1].replace(/-\d+$/, '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }
  name = cleanName(name || 'Movie');
  let date = 'See movie page', time = 'See movie page', location = 'AMC Theatres', rating = '', runtime = '', rawDate = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html());
      const item = Array.isArray(json) ? json.find(j => j['@type'] === 'Movie' || j['@type'] === 'ScreeningEvent') : json;
      if (item) {
        if (item.startDate) {
          rawDate = item.startDate;
          const d = new Date(item.startDate);
          date = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
          time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        }
        location = (item.location && item.location.name) || 'AMC Theatres';
        rating = item.contentRating || '';
        if (item.duration) {
          const match = item.duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
          if (match) runtime = ((match[1] ? `${match[1]}h ` : '') + (match[2] ? `${match[2]}m` : '')).trim();
        }
      }
    } catch (e) {}
  });
  if (location === 'AMC Theatres') {
    const theaterMatch = $('title').text().match(/at\s+(.+?)(\s*[-|]|$)/i);
    if (theaterMatch) location = theaterMatch[1].trim().slice(0, 100);
  }
  const ratingRuntime = [rating, runtime].filter(Boolean).join(' · ') || 'N/A';
  const description = ($('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || 'N/A').slice(0, 200);
  return { name, date, time, location: location.slice(0, 100), description, ratingRuntime, rawDate };
}

async function scrapeCinemark(url) {
  const { data } = await axios.get(url, { headers: SCRAPE_HEADERS });
  const $ = cheerio.load(data);
  let name = $('meta[property="og:title"]').attr('content') || $('h1').first().text().trim();
  if (!name || name.toLowerCase().includes('cinemark')) {
    const urlMatch = url.match(/\/movies\/([^\/\?]+)/i);
    if (urlMatch) name = urlMatch[1].replace(/-\d+$/, '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }
  name = cleanName(name || 'Movie');
  let date = 'See movie page', time = 'See movie page', location = 'Cinemark', rating = '', runtime = '', rawDate = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html());
      const item = Array.isArray(json) ? json.find(j => j['@type'] === 'Movie' || j['@type'] === 'ScreeningEvent') : json;
      if (item) {
        if (item.startDate) {
          rawDate = item.startDate;
          const d = new Date(item.startDate);
          date = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
          time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        }
        location = (item.location && item.location.name) || 'Cinemark';
        rating = item.contentRating || '';
        if (item.duration) {
          const match = item.duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
          if (match) runtime = ((match[1] ? `${match[1]}h ` : '') + (match[2] ? `${match[2]}m` : '')).trim();
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
  return { name, date, time, location: location.slice(0, 100), description, ratingRuntime, rawDate };
}

async function scrapeByUrl(url) {
  const site = detectSite(url);
  if (!site) return null;
  const scrapers = { luma: scrapeLuma, eventbrite: scrapeEventbrite, dice: scrapeDice, fever: scrapeFever, amc: scrapeAMC, cinemark: scrapeCinemark };
  const scraper = scrapers[site];
  if (!scraper) return null;
  const eventData = await scraper(url);
  return { eventData, site };
}

function validatePayload(payload) {
  const fieldGroups = ['headerFields', 'primaryFields', 'secondaryFields', 'auxiliaryFields', 'backFields'];
  for (const group of fieldGroups) {
    if (!payload[group]) continue;
    if (payload[group].length > 10) throw new Error(`${group} has ${payload[group].length} items — max is 10`);
    for (const field of payload[group]) {
      if (!field.label || !field.label.trim()) throw new Error(`Empty label in ${group}`);
      if (!field.value || !field.value.trim()) throw new Error(`Empty value for label "${field.label}" in ${group}`);
    }
  }
  const topLevel = ['barcodeValue', 'logoText', 'description', 'organizationName', 'colorPreset'];
  for (const key of topLevel) {
    if (!payload[key] || !String(payload[key]).trim()) throw new Error(`Empty top-level field: ${key}`);
  }
}

async function generatePass(eventData, eventUrl, site, passholder = null, seatType = null) {
  const isMovie = isMovieSite(site);
  const color = colorForSite(site);
  const passholderVal = safeVal(passholder ? passholder.toUpperCase() : null, 'GUEST');
  const movieSeat = generateMovieSeat();
  const eventSeat = generateEventSeat();
  if (seatType) {
    if (isMovie) movieSeat.auditorium = seatType;
    else eventSeat.section = seatType;
  }
  const expirationDate = getExpirationDate(eventData.rawDate);

  const passPayload = isMovie ? {
    barcodeValue: safeVal(eventUrl, 'https://keypass.app'),
    barcodeFormat: 'QR',
    logoText: safeVal(eventData.location, site === 'amc' ? 'AMC THEATRES' : 'CINEMARK'),
    description: safeVal(eventData.name, 'Movie'),
    organizationName: 'Keypass',
    colorPreset: color,
    headerFields: [
      { label: 'DATE', value: safeVal(eventData.date, 'See page') },
      { label: 'TIME', value: safeVal(eventData.time, 'See page') }
    ],
    primaryFields: [
      { label: safeVal(eventData.location, site === 'amc' ? 'AMC' : 'CINEMARK'), value: safeVal(eventData.name, 'Movie') }
    ],
    secondaryFields: [
      { label: 'BRING YOUR PHOTO ID', value: passholderVal }
    ],
    auxiliaryFields: [
      { label: 'AUDITORIUM', value: safeVal(movieSeat.auditorium) },
      { label: 'SEAT', value: safeVal(movieSeat.row) + safeVal(movieSeat.seat) },
      { label: 'TICKETS', value: '1 ADULT' }
    ],
    backFields: [
      { label: 'PASSHOLDER', value: passholderVal },
      { label: 'FILM', value: safeVal(eventData.name, 'Movie') },
      { label: 'THEATER', value: safeVal(eventData.location, 'See page') },
      { label: 'DATE', value: safeVal(eventData.date, 'See page') },
      { label: 'TIME', value: safeVal(eventData.time, 'See page') },
      { label: 'AUDITORIUM', value: safeVal(movieSeat.auditorium) },
      { label: 'ROW', value: safeVal(movieSeat.row) },
      { label: 'SEAT', value: safeVal(movieSeat.seat) },
      { label: 'TICKETS', value: '1 ADULT' },
      { label: 'RATING / RUNTIME', value: safeVal(eventData.ratingRuntime, 'N/A') }
    ]
  } : {
    barcodeValue: safeVal(eventUrl, 'https://keypass.app'),
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
      { label: 'EVENT', value: safeVal(eventData.name, 'Event') }
    ],
    secondaryFields: [
      { label: 'DATE', value: safeVal(eventData.date, 'See page') },
      { label: 'TIME', value: safeVal(eventData.time, 'Doors Open') },
      { label: 'SECTION', value: safeVal(eventSeat.section) },
      { label: 'ROW / SEAT', value: safeVal(eventSeat.row) + ' / ' + safeVal(eventSeat.seat) }
    ],
    auxiliaryFields: [
      { label: 'GATE', value: safeVal(eventSeat.gate) },
      { label: 'VENUE', value: safeVal(eventData.location, 'See page') }
    ],
    backFields: [
      { label: 'PASSHOLDER', value: passholderVal },
      { label: 'EVENT', value: safeVal(eventData.name, 'Event') },
      { label: 'VENUE', value: safeVal(eventData.location, 'See page') },
      { label: 'DATE', value: safeVal(eventData.date, 'See page') },
      { label: 'TIME', value: safeVal(eventData.time, 'See page') },
      { label: 'SECTION', value: safeVal(eventSeat.section) },
      { label: 'ROW', value: safeVal(eventSeat.row) },
      { label: 'SEAT', value: safeVal(eventSeat.seat) },
      { label: 'GATE', value: safeVal(eventSeat.gate) },
      { label: 'TICKET', value: 'TKT-' + Math.random().toString(36).toUpperCase().slice(2, 7) }
    ]
  };

  if (expirationDate) passPayload.expirationDate = expirationDate;

  validatePayload(passPayload);

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
      console.error('WalletWallet error body:', errorBody);
      console.error('Payload sent:', JSON.stringify(passPayload, null, 2));
      throw new Error(`Pass generation failed: ${errorBody}`);
    }
    throw err;
  }

  const fileName = `pass_${Date.now()}.pkpass`;
  const filePath = path.join('/tmp', fileName);
  fs.writeFileSync(filePath, response.data);
  const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;

  return { passUrl: `${baseUrl}/passes/${fileName}`, movieSeat, eventSeat, isMovie };
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

  if (req.body.callback_query) {
    const cb = req.body.callback_query;
    const chatId = cb.message.chat.id;
    const data = cb.data;
    await answerCallbackQuery(cb.id);
    if (data === 'type_movie' || data === 'type_concert') {
      const type = data === 'type_movie' ? 'movie' : 'concert';
      userState[chatId] = { ...userState[chatId], selectedType: type, waitingForUrl: true };
      const msg = type === 'movie'
        ? `🎬 Movie pass selected!\n\nSupported sites:\n• AMC Theatres\n• Cinemark\n\nSend me the link!`
        : `🎤 Concert / Event pass selected!\n\nSupported sites:\n• Fever Up\n• lu.ma\n• Eventbrite\n• Dice\n\nSend me the link!`;
      await sendMessage(chatId, msg);
    }
    return;
  }

  const message = req.body.message;
  if (!message || !message.text) return;

  const chatId = message.chat.id;
  const incomingMsg = message.text.trim();
  console.log(`[${chatId}] ${incomingMsg}`);

  if (incomingMsg === '/start' || incomingMsg === '/new') {
    userState[chatId] = {};
    await sendInlineKeyboard(
      chatId,
      `🎟️ Welcome to Keypass!\n\nWhat kind of pass do you need?\n\n🎬 MOVIES\nAMC · Cinemark\n\n🎤 CONCERTS & EVENTS\nFever Up · lu.ma · Eventbrite · Dice`,
      [[{ text: '🎬 Movie', callback_data: 'type_movie' }, { text: '🎤 Concert / Event', callback_data: 'type_concert' }]]
    );
    return;
  }

  if (incomingMsg === '/last') {
    const last = userState[chatId]?.lastPassUrl;
    await sendMessage(chatId, last ? `🎟️ Your last pass:\n${last}` : `No pass generated yet. Send /start to begin.`);
    return;
  }

  if (incomingMsg === '/help') {
    await sendMessage(chatId,
      `🎟️ Keypass Bot\n\n🎬 Movie sites:\n• amctheatres.com\n• cinemark.com\n\n🎤 Concert / Event sites:\n• lu.ma\n• eventbrite.com\n• dice.fm\n• feverup.com\n\nCommands:\n/start — new pass\n/last — resend last pass\n/help — this message`
    );
    return;
  }

  if (!userState[chatId]?.selectedType) {
    userState[chatId] = {};
    await sendInlineKeyboard(
      chatId,
      `What kind of pass do you need?\n\n🎬 MOVIES\nAMC · Cinemark\n\n🎤 CONCERTS & EVENTS\nFever Up · lu.ma · Eventbrite · Dice`,
      [[{ text: '🎬 Movie', callback_data: 'type_movie' }, { text: '🎤 Concert / Event', callback_data: 'type_concert' }]]
    );
    return;
  }

  if (userState[chatId]?.waitingForTime) {
    const customTime = incomingMsg.toLowerCase() === 'skip' ? null : incomingMsg;
    const pending = userState[chatId].pendingPasses;
    if (customTime) {
      for (const p of pending) p.eventData.time = customTime;
    }
    userState[chatId].waitingForTime = false;
    userState[chatId].waitingForDate = true;
    userState[chatId].pendingPasses = pending;
    const scrapedDate = pending[0]?.eventData?.date;
    const dateKnown = scrapedDate && scrapedDate !== 'See event page' && scrapedDate !== 'See movie page';
    await sendMessage(chatId, `📅 What date should show on the pass?${dateKnown ? `\nScraped: ${scrapedDate} — reply with a new date or type "skip" to keep it` : `\nCouldn't find a date. Reply with a date (e.g. Sat, Jun 7 2025) or type "skip"`}`);
    return;
  }

  if (userState[chatId]?.waitingForDate) {
    const customDate = incomingMsg.toLowerCase() === 'skip' ? null : incomingMsg;
    const pending = userState[chatId].pendingPasses;
    if (customDate) {
      for (const p of pending) p.eventData.date = customDate;
    }
    userState[chatId].waitingForDate = false;
    userState[chatId].waitingForSeat = true;
    userState[chatId].pendingPasses = pending;
    const seatOptions = userState[chatId].selectedType === 'movie'
      ? `🎬 Movie seat types:\nGeneral Admission, Recliner, Dolby, IMAX, Premium, VIP, Rooftop, Drive-In`
      : `🎤 Event seat types:\nGA (General Admission), Floor, Pit, VIP, Lounge, Balcony, Mezzanine, Section, Skybox, Lawn`;
    await sendMessage(chatId, `💺 What type of seat?\n\n${seatOptions}\n\nType your section/seat type or "skip"`);
    return;
  }

  if (userState[chatId]?.waitingForSeat) {
    const customSeat = incomingMsg.toLowerCase() === 'skip' ? null : incomingMsg.toUpperCase();
    userState[chatId].seatType = customSeat;
    userState[chatId].waitingForSeat = false;
    userState[chatId].waitingForName = true;
    await sendMessage(chatId, `What name should go on the pass?\nReply with a name or type "skip"`);
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
        const { passUrl, movieSeat, eventSeat, isMovie } = await generatePass(eventData, url, site, name, userState[chatId].seatType);
        userState[chatId].lastPassUrl = passUrl;
        const details = isMovie
          ? `AUDITORIUM ${movieSeat.auditorium} · SEAT ${movieSeat.row}${movieSeat.seat}`
          : `${eventSeat.section} · ROW ${eventSeat.row} · SEAT ${eventSeat.seat} · ${eventSeat.gate}`;
        await sendMessage(chatId, `✅ ${eventData.name}\n${details}\n\nTap to add to Apple Wallet:\n${passUrl}`);
      } catch (err) {
        console.error(err);
        await sendMessage(chatId, `❌ Failed for ${url}:\n${err.message}`);
      }
    }

    userState[chatId].selectedType = null;
    userState[chatId].waitingForUrl = false;
    userState[chatId].seatType = null;
    return;
  }

  if (userState[chatId]?.waitingForUrl) {
    const urls = extractURLs(incomingMsg);
    const validUrls = urls.filter(u => detectSite(u));

    if (validUrls.length === 0) {
      await sendMessage(chatId, `⚠️ I didn't find a supported URL in that message. Please send a link from a supported site.`);
      return;
    }

    const selectedType = userState[chatId].selectedType;
    const wrongType = validUrls.filter(u => {
      const site = detectSite(u);
      const urlIsMovie = isMovieSite(site);
      return selectedType === 'movie' ? !urlIsMovie : urlIsMovie;
    });

    if (wrongType.length > 0 && wrongType.length === validUrls.length) {
      const expected = selectedType === 'movie' ? '🎬 movie' : '🎤 concert/event';
      await sendMessage(chatId, `⚠️ That link doesn't look like a ${expected} site. Please send the right kind of link, or send /start to pick again.`);
      return;
    }

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
      const isMovie = isMovieSite(site);
      preview += `🎟️ ${eventData.name}\n`;
      preview += `📅 ${eventData.date}`;
      if (eventData.time && eventData.time !== 'See event page' && eventData.time !== 'See movie page') {
        preview += ` @ ${eventData.time}`;
      }
      preview += `\n📍 ${eventData.location}\n`;
      if (isMovie && eventData.ratingRuntime && eventData.ratingRuntime !== 'N/A') {
        preview += `🎬 ${eventData.ratingRuntime}\n`;
      }
      preview += `\n`;
    }
    await sendMessage(chatId, preview.trim());

    const scrapedTime = results[0]?.eventData?.time;
    const timeKnown = scrapedTime && scrapedTime !== 'See event page' && scrapedTime !== 'See movie page';
    await sendMessage(chatId, `⏰ What time should show on the pass?${timeKnown ? `\nScraped: ${scrapedTime} — reply with a new time or type "skip" to keep it` : `\nCouldn't find a time. Reply with a time (e.g. 8:00 PM) or type "skip"`}`);

    userState[chatId].waitingForTime = true;
    userState[chatId].waitingForUrl = false;
    userState[chatId].pendingPasses = results;
    return;
  }
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
