
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
const session = require('express-session');
const jwt = require('jsonwebtoken'); // npm install jsonwebtoken
const OpenAI = require('openai');
const app = express();
const PORT = 5000;
require('dotenv').config();
const PPLX_API_KEY = process.env.PPLX_API_KEY;

const config = {
  clientId: process.env.SMART_CLIENT_ID,
  clientSecret: process.env.SMART_CLIENT_SECRET,
  redirectUri: 'http://localhost:5000/redirect',
  authorizationEndpoint: 'http://localhost:8080/oauth2/default/authorize',
  tokenEndpoint: 'http://localhost:8080/oauth2/default/token',
  fhirBaseUrl: 'http://localhost:8080/apis/default/fhir',
  scope: 'openid launch fhirUser user/Patient.read user/Observation.read user/Condition.read user/MedicationRequest.read user/DiagnosticReport.read user/AllergyIntolerance.read user/Practitioner.read user/Person.read offline_access'
};

// Initialize OpenAI client if using real OpenAI integration
// const openai = new OpenAI({
//   apiKey: process.env.OPENAI_API_KEY
// });

app.use(cors({
  origin: 'http://localhost:3000',
  credentials: true
}));

app.use(express.json());
app.use(session({
  secret: 'your-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));

function generatePKCE() {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');

  return { codeVerifier, codeChallenge };
}

app.get('/launch', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  const { codeVerifier, codeChallenge } = generatePKCE();

  req.session.state = state;
  req.session.codeVerifier = codeVerifier;

  const authUrl = new URL(config.authorizationEndpoint);
  authUrl.searchParams.append('response_type', 'code');
  authUrl.searchParams.append('client_id', config.clientId);
  authUrl.searchParams.append('redirect_uri', config.redirectUri);
  authUrl.searchParams.append('scope', config.scope);
  authUrl.searchParams.append('state', state);
  authUrl.searchParams.append('aud', config.fhirBaseUrl);
  authUrl.searchParams.append('code_challenge', codeChallenge);
  authUrl.searchParams.append('code_challenge_method', 'S256');

  res.json({ authUrl: authUrl.toString() });
});


app.get('/redirect', async (req, res) => {
  const { code, state } = req.query;

  if (!state || state !== req.session.state) {
    return res.redirect(`http://localhost:3000?error=invalid_state`);
  }

  try {
    const tokenResponse = await axios.post(
      config.tokenEndpoint,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.redirectUri,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code_verifier: req.session.codeVerifier
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, refresh_token, scope, id_token } = tokenResponse.data;

    req.session.accessToken = access_token;
    req.session.refreshToken = refresh_token;
    req.session.grantedScope = scope;
    req.session.idToken = id_token;

    delete req.session.state;
    delete req.session.codeVerifier;

    res.redirect('http://localhost:3000?auth=success');
  } catch (error) {
    console.error('Token exchange error:', error.response?.data || error.message);
    res.redirect('http://localhost:3000?error=token_exchange_failed');
  }
});



// Helper to get fhirUser and load the corresponding FHIR resource
async function getCurrentFhirUser(accessToken, idToken) {
  if (!idToken) return null;

  let decoded;
  try {
    decoded = jwt.decode(idToken); // no verification – fine for local dev
  } catch (e) {
    console.error('Failed to decode id_token', e.message);
    return null;
  }
  console.log("decoded id token", decoded);
  const fhirUser = decoded?.fhirUser || decoded?.extension_fhirUser;
  if (!fhirUser) return null;

  // fhirUser is typically a URL like: http://localhost:8080/apis/default/fhir/Practitioner/123
  const url = fhirUser.startsWith('http')
    ? fhirUser
    : `${config.fhirBaseUrl}/${fhirUser.replace(/^\//, '')}`;

  try {
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/fhir+json'
      }
    });
    return response.data;
  } catch (err) {
    console.error('Error loading fhirUser resource:', err.response?.data || err.message);
    return null;
  }
}

// Endpoint to expose current provider/user info
app.get('/api/user/me', async (req, res) => {
  if (!req.session.accessToken) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    console.log("id token", req.session.idToken);
    console.log("access token", req.session.accessToken);
    const userResource = await getCurrentFhirUser(req.session.accessToken, req.session.idToken);

    if (!userResource) {
      return res.json({ authenticated: true, user: null });
    }

    // Normalized shape: { id, resourceType, name }
    let displayName = 'Unknown';
    if (userResource.name && userResource.name.length > 0) {
      const n = userResource.name[0];
      const given = n.given ? n.given.join(' ') : '';
      const family = n.family || '';
      displayName = `${given} ${family}`.trim() || 'Unknown';
    } else if (userResource.practitionerRole && userResource.practitionerRole[0]?.practitioner?.display) {
      displayName = userResource.practitionerRole[0].practitioner.display;
    }

    res.json({
      authenticated: true,
      user: {
        id: userResource.id,
        resourceType: userResource.resourceType,
        name: displayName
      }
    });
  } catch (e) {
    console.error('Error in /api/user/me:', e.message);
    res.status(500).json({ error: 'Failed to load user profile' });
  }
});


// Helper function for FHIR requests
async function makeFHIRRequest(accessToken, resource, params = {}) {
  try {
    const response = await axios.get(`${config.fhirBaseUrl}/${resource}`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/fhir+json'
      },
      params
    });
    return response.data;
  } catch (error) {
    console.error(`FHIR ${resource} error:`, error.response?.data || error.message);
    throw error;
  }
}

app.get('/api/patients', async (req, res) => {
  if (!req.session.accessToken) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const data = await makeFHIRRequest(req.session.accessToken, 'Patient', { _count: 50 });
    res.json(data);
  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: 'Failed to fetch patients',
      details: error.response?.data
    });
  }
});

// Get patient vital signs
app.get('/api/patient/:id/vitals', async (req, res) => {
  if (!req.session.accessToken) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const data = await makeFHIRRequest(req.session.accessToken, 'Observation', {
      patient: req.params.id,
      category: 'vital-signs',
      _count: 20,
      _sort: '-date'
    });
    res.json(data);
  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: 'Failed to fetch vitals',
      details: error.response?.data
    });
  }
});

// Get patient lab results
app.get('/api/patient/:id/labs', async (req, res) => {
  if (!req.session.accessToken) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const data = await makeFHIRRequest(req.session.accessToken, 'Observation', {
      patient: req.params.id,
      category: 'laboratory',
      _count: 20,
      _sort: '-date'
    });
    res.json(data);
  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: 'Failed to fetch labs',
      details: error.response?.data
    });
  }
});

// Get patient conditions
app.get('/api/patient/:id/conditions', async (req, res) => {
  if (!req.session.accessToken) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const data = await makeFHIRRequest(req.session.accessToken, 'Condition', {
      patient: req.params.id,
      _count: 20,
      _sort: '-recorded-date'
    });
    res.json(data);
  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: 'Failed to fetch conditions',
      details: error.response?.data
    });
  }
});

// Get patient medications
app.get('/api/patient/:id/medications', async (req, res) => {
  if (!req.session.accessToken) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const data = await makeFHIRRequest(req.session.accessToken, 'MedicationRequest', {
      patient: req.params.id,
      _count: 20,
      _sort: '-authoredon'
    });
    res.json(data);
  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: 'Failed to fetch medications',
      details: error.response?.data
    });
  }
});

// Get patient diagnostic reports
app.get('/api/patient/:id/diagnostic-reports', async (req, res) => {
  if (!req.session.accessToken) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const data = await makeFHIRRequest(req.session.accessToken, 'DiagnosticReport', {
      patient: req.params.id,
      _count: 20,
      _sort: '-date'
    });
    res.json(data);
  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: 'Failed to fetch diagnostic reports',
      details: error.response?.data
    });
  }
});


// Helper function to format patient data for AI analysis
function formatPatientDataForAI(patientData) {
  let formattedData = '';

  // Vitals Summary
  if (patientData.vitals && patientData.vitals.length > 0) {
    formattedData += '## Vital Signs:\n';
    const validVitals = patientData.vitals.filter(entry => {
      const obs = entry.resource;
      return !obs.hasMember && !obs.dataAbsentReason;
    });

    validVitals.slice(0, 10).forEach(entry => {
      const obs = entry.resource;
      const name = obs.code?.coding?.[0]?.display || obs.code?.text || 'Unknown';
      let value = 'N/A';

      if (obs.valueQuantity) {
        value = `${obs.valueQuantity.value} ${obs.valueQuantity.unit || ''}`;
      } else if (obs.valueString) {
        value = obs.valueString;
      } else if (obs.component) {
        value = obs.component.map(c =>
          `${c.code?.coding?.[0]?.display}: ${c.valueQuantity?.value}${c.valueQuantity?.unit || ''}`
        ).join(', ');
      }

      formattedData += `- ${name}: ${value}\n`;
    });
    formattedData += '\n';
  }

  // Labs Summary
  if (patientData.labs && patientData.labs.length > 0) {
    formattedData += '## Laboratory Results:\n';
    patientData.labs.slice(0, 10).forEach(entry => {
      const obs = entry.resource;
      const name = obs.code?.coding?.[0]?.display || obs.code?.text || 'Unknown';
      let value = 'N/A';

      if (obs.valueQuantity) {
        value = `${obs.valueQuantity.value} ${obs.valueQuantity.unit || ''}`;
      } else if (obs.valueCodeableConcept) {
        value = obs.valueCodeableConcept.text || obs.valueCodeableConcept.coding?.[0]?.display || 'N/A';
      }

      formattedData += `- ${name}: ${value}\n`;
    });
    formattedData += '\n';
  }

  // Conditions
  if (patientData.conditions && patientData.conditions.length > 0) {
    formattedData += '## Active Conditions:\n';
    patientData.conditions.forEach(entry => {
      const condition = entry.resource;
      const name = condition.code?.text || condition.code?.coding?.[0]?.display || 'Unknown';
      const status = condition.clinicalStatus?.coding?.[0]?.code || 'unknown';
      formattedData += `- ${name} (Status: ${status})\n`;
    });
    formattedData += '\n';
  }

  // Medications
  if (patientData.medications && patientData.medications.length > 0) {
    formattedData += '## Current Medications:\n';
    patientData.medications.forEach(entry => {
      const med = entry.resource;
      const name = med.medicationCodeableConcept?.text ||
        med.medicationCodeableConcept?.coding?.[0]?.display || 'Unknown';
      const dosage = med.dosageInstruction?.[0]?.text || 'No dosage info';
      formattedData += `- ${name}: ${dosage}\n`;
    });
    formattedData += '\n';
  }

  // Diagnostic Reports
  if (patientData.diagnosticReports && patientData.diagnosticReports.length > 0) {
    formattedData += '## Recent Diagnostic Reports:\n';
    patientData.diagnosticReports.slice(0, 5).forEach(entry => {
      const report = entry.resource;
      const name = report.code?.text || report.code?.coding?.[0]?.display || 'Unknown';
      const status = report.status || 'unknown';
      formattedData += `- ${name} (Status: ${status})\n`;
    });
    formattedData += '\n';
  }

  return formattedData;
}

/*
// AI Recommendations endpoint with real OpenAI integration
app.post('/api/ai/recommendations', async (req, res) => {
  if (!req.session.accessToken) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { patientData, patientId } = req.body;

  console.log('Generating AI recommendations for patient:', patientId);

  try {
    // Format patient data for better AI analysis
    const formattedData = formatPatientDataForAI(patientData);

    if (!formattedData.trim()) {
      return res.json({
        recommendations: 'No patient data available to generate recommendations. Please ensure the patient has recorded vitals, conditions, medications, or lab results.'
      });
    }

    // Create clinical prompt with structured patient data
    const systemPrompt = `You are an experienced clinical decision support AI assistant. 
Your role is to analyze patient data and provide evidence-based clinical recommendations.

Guidelines:
- Provide actionable, specific recommendations
- Identify any concerning trends or values
- Suggest appropriate follow-up actions
- Mention potential drug interactions if applicable
- Recommend lifestyle modifications when relevant
- Be concise but thorough
- Always emphasize that recommendations should be reviewed by healthcare providers
- Format your response with clear sections using markdown`;

    const userPrompt = `Please analyze the following patient data and provide clinical recommendations:

${formattedData}

Provide recommendations covering:
1. Assessment of current vital signs and labs
2. Condition management recommendations
3. Medication review and interactions
4. Suggested follow-up actions
5. Lifestyle modifications if applicable`;

    console.log('Sending request to OpenAI...');

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini", // Use gpt-4o, gpt-4o-mini, or gpt-4
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: 1500
    });

    const recommendations = completion.choices[0].message.content;
    console.log('AI recommendations generated successfully');

    // Add disclaimer
    const fullRecommendations = `${recommendations}

---
**Disclaimer:** These recommendations are generated by AI and should be reviewed by qualified healthcare providers before implementation. They are meant to assist clinical decision-making, not replace professional medical judgment.`;

    res.json({ recommendations: fullRecommendations });

  } catch (error) {
    console.error('AI recommendations error:', error);

    // Provide more specific error messages
    if (error.code === 'insufficient_quota') {
      return res.status(500).json({
        error: 'OpenAI API quota exceeded',
        details: 'Please check your OpenAI account billing and usage limits'
      });
    }

    if (error.code === 'invalid_api_key') {
      return res.status(500).json({
        error: 'Invalid OpenAI API key',
        details: 'Please check your OPENAI_API_KEY environment variable'
      });
    }

    res.status(500).json({
      error: 'Failed to generate recommendations',
      details: error.message
    });
  }
});
*/


// AI Recommendations endpoint with Perplexity pplx-api
app.post('/api/ai/recommendations', async (req, res) => {
  if (!req.session.accessToken) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { patientData, patientId } = req.body;
  console.log('Generating AI recommendations for patient:', patientId);
  console.log('patientData:', patientData);

  try {
    const formattedData = formatPatientDataForAI(patientData);
    console.log('Formatted patient data for AI:', formattedData);

    if (!formattedData.trim()) {
      return res.json({
        recommendations: 'No patient data available to generate recommendations. Please ensure the patient has recorded vitals, conditions, medications, or lab results.'
      });
    }


    const userPrompt = `You are a clinical decision support assistant.

Analyze the following patient data and return a VERY SHORT summary in EXACTLY this format:

Out of range values:
- ...

Recommended actions:
- ...

Rules:
- Do NOT add any other headings or text.
- No explanations, no references, no citations, no markdown beyond the two headings and bullet points.
- Keep to 3–5 bullets per section.
- If nothing is out of range, write: "None clearly out of range based on provided data."

Patient data:
${formattedData}`;


    console.log('Sending request to Perplexity pplx-api...');

    const pplxResponse = await axios.post(
      'https://api.perplexity.ai/chat/completions',
      {
        model: 'sonar-pro', // or 'sonar', depending on your plan [web:72][web:74]
        messages: [
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.3,      // lower temp for more deterministic, terse output
        max_tokens: 400
      },
      {
        headers: {
          'Authorization': `Bearer ${PPLX_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const recommendations = pplxResponse.data.choices[0].message.content;
    console.log('Perplexity recommendations generated successfully', recommendations);

    const fullRecommendations = `${recommendations}`;

    res.json({ recommendations: fullRecommendations });

  } catch (error) {
    console.error('AI recommendations error (Perplexity):', error.response?.data || error.message);

    // Basic error surfacing
    res.status(500).json({
      error: 'Failed to generate recommendations',
      details: error.response?.data || error.message
    });
  }
});

app.get('/api/auth/status', (req, res) => {
  res.json({
    authenticated: !!req.session.accessToken,
    scope: req.session.grantedScope || null,
    hasIdToken: !!req.session.idToken
  });
});


app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('OpenAI API Key configured:', !!process.env.OPENAI_API_KEY);
});