const fetch = require('node-fetch');
const { Busboy } = require('busboy');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
  if (!REPLICATE_API_TOKEN) {
    return { statusCode: 500, body: JSON.stringify({ error: 'API key not configured' }) };
  }

  try {
    const fields = await parseMultipart(event);
    const imageBuffer = Buffer.from(fields.image, 'base64');
    const videoBuffer = fields.video ? Buffer.from(fields.video, 'base64') : null;
    const mode = fields.mode;

    let prediction;
    if (mode === 'txt2vid') {
      const imageUrl = await uploadToReplicate(imageBuffer, REPLICATE_API_TOKEN);
      prediction = await replicateCreatePrediction(
        'stability-ai/stable-video-diffusion:3f0457e4619daac51203dedb472816fd4af51f3149fa7a9e0b5ffcf1b8172438',
        { input_image: imageUrl },
        REPLICATE_API_TOKEN
      );
    } else if (mode === 'faceswap') {
      const [imageUrl, videoUrl] = await Promise.all([
        uploadToReplicate(imageBuffer, REPLICATE_API_TOKEN),
        uploadToReplicate(videoBuffer, REPLICATE_API_TOKEN),
      ]);
      prediction = await replicateCreatePrediction(
        'lucataco/faceswap:9f3bf61910f72b8c6a8f4de5b9b42c8e4b7b41f95f9c08e4ef68e1e5b5c9e0d1',
        { target: videoUrl, source: imageUrl },
        REPLICATE_API_TOKEN
      );
    }

    if (prediction && prediction.output) {
      const outputUrl = prediction.output
        ? (typeof prediction.output === 'string' ? prediction.output : prediction.output[0])
        : null;
      return {
        statusCode: 200,
        body: JSON.stringify({ output: outputUrl }),
      };
    } else {
      return {
        statusCode: 200,
        body: JSON.stringify({ error: 'Prediction failed', details: prediction }),
      };
    }
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};

async function replicateCreatePrediction(model, input, token) {
  const [owner, modelVersion] = model.split(':');
  const response = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: {
      Authorization: `Token ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ version: modelVersion, input }),
  });
  const prediction = await response.json();

  let result = prediction;
  while (result.status !== 'succeeded' && result.status !== 'failed' && result.status !== 'canceled') {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const poll = await fetch(result.urls.get, {
      headers: { Authorization: `Token ${token}` },
    });
    result = await poll.json();
  }
  return result;
}

async function uploadToReplicate(buffer, token) {
  const response = await fetch('https://api.replicate.com/v1/files', {
    method: 'POST',
    headers: {
      Authorization: `Token ${token}`,
      'Content-Type': 'application/octet-stream',
    },
    body: buffer,
  });
  const json = await response.json();
  return json.urls.get;
}

function parseMultipart(event) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: { 'content-type': event.headers['content-type'] } });
    const fields = {};
    busboy.on('file', (name, file, info) => {
      const chunks = [];
      file.on('data', (chunk) => chunks.push(chunk));
      file.on('end', () => {
        fields[name] = Buffer.concat(chunks).toString('base64');
      });
    });
    busboy.on('field', (name, val) => (fields[name] = val));
    busboy.on('finish', () => resolve(fields));
    busboy.on('error', reject);
    busboy.write(event.body, event.isBase64Encoded ? 'base64' : 'binary');
    busboy.end();
  });
}
