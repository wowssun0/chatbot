const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const dialogflow = require('@google-cloud/dialogflow');
const textToSpeech = require('@google-cloud/text-to-speech');
const { google } = require('googleapis');
const cors = require('cors');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(cors({
  origin: (origin, cb) => {
    const allow = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!origin || allow.length === 0 || allow.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  }
}));

let useLocalKey = false;
let keyPath = path.join(__dirname, 'voice-key.json');
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && fs.existsSync(keyPath)) {
  useLocalKey = true;
}

const projectId = (useLocalKey
  ? JSON.parse(fs.readFileSync(keyPath, 'utf8')).project_id
  : process.env.DIALOGFLOW_PROJECT_ID);

const sessionsClient = useLocalKey
  ? new dialogflow.SessionsClient({ keyFilename: keyPath })
  : new dialogflow.SessionsClient();

const ttsClient = useLocalKey
  ? new textToSpeech.TextToSpeechClient({ keyFilename: keyPath })
  : new textToSpeech.TextToSpeechClient();

const LEDA_VOICE = process.env.TTS_VOICE_NAME || 'ko-KR-Chirp3-HD-Leda';
const END_TEXT = process.env.END_TEXT || '대화 시간이 끝났어요. 설문으로 돌아가 아래 본인확인코드를 입력하고 이어서 설문에 답변해 주세요. 감사합니다!';

const auth = useLocalKey
  ? new google.auth.GoogleAuth({ keyFile: keyPath, scopes: ['https://www.googleapis.com/auth/spreadsheets'] })
  : new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] });

const sheets = google.sheets({ version: 'v4', auth });
const SPREADSHEET_ID = process.env.SHEETS_ID || '1PgHV6dNl0SyO0gRX4lkWR1fr4n-QgsVKlHCV2lStdAY';
const SHEET_NAME = process.env.SHEETS_TAB || 'chatlog';

app.get('/health', (_req, res) => res.status(200).send('ok'));

app.get('/end-audio', async (_req, res) => {
  try {
    const [ttsRes] = await ttsClient.synthesizeSpeech({
      input: { text: END_TEXT },
      voice: { languageCode: 'ko-KR', name: LEDA_VOICE },
      audioConfig: { audioEncoding: 'MP3', speakingRate: 1.0, pitch: 0.0 }
    });
    res.json({ reply: END_TEXT, audio: ttsRes.audioContent.toString('base64'), mime: 'audio/mpeg' });
  } catch (_e) {
    res.json({ reply: END_TEXT, audio: null, mime: 'audio/mpeg' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.post('/query', async (req, res) => {
  try {
    const { text, lang = 'ko', cond = 'text', pid = 'anon', turn = null } = req.body;
    if (global.isEnded) return res.json({ reply: '(대화가 종료되었습니다)', audio: null, mime: 'audio/mpeg' });

    const sessionPath = sessionsClient.projectAgentSessionPath(projectId, uuidv4());
    const request = { session: sessionPath, queryInput: { text: { text, languageCode: lang } } };
    if (cond === 'voice') {
      request.outputAudioConfig = {
        audioEncoding: 'OUTPUT_AUDIO_ENCODING_MP3',
        synthesizeSpeechConfig: { voice: { name: LEDA_VOICE }, speakingRate: 1.0, pitch: 0.0 }
      };
    }

    const t0 = Date.now();
    const [dfRes] = await sessionsClient.detectIntent(request);
    const rtMs = Date.now() - t0;

    const replyText = (dfRes?.queryResult?.fulfillmentText || '').trim();
    const isEnd = replyText === END_TEXT;

    const timestamp = new Date().toISOString();
    try {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A:J`,
        valueInputOption: 'RAW',
        requestBody: {
          values: [[
            timestamp,
            pid,
            cond,
            rtMs,
            turn,
            isEnd,
            sessionPath,
            text,
            replyText,
            cond === 'voice' ? 'hasAudio' : ''
          ]]
        }
      });
    } catch (err) {
      console.error('Sheets append error:', err?.message || err);
    }

    if (cond === 'voice') {
      const audioBytes = dfRes.outputAudio;
      return res.json({ reply: replyText, audio: audioBytes ? audioBytes.toString('base64') : null, mime: 'audio/mpeg', rt_ms: rtMs });
    }
    res.json({ reply: replyText, rt_ms: rtMs });
  } catch (e) {
    console.error('query error', e);
    res.status(500).json({ error: 'dialogflow error' });
  }
});

app.listen(port, () => {
  console.log(`✅ Chatbot server running on port ${port}`);
});


