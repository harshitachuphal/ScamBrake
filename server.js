import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import fs from "node:fs/promises";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

await fs.mkdir("uploads", { recursive: true });
await fs.mkdir("public", { recursive: true });

const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 15 * 1024 * 1024 }
});

app.use(express.json({ limit: "64kb" }));
app.use(express.static("public"));

app.use((req, res, next) => {
  console.log("INCOMING REQUEST:", req.method, req.url);
  next();
});

// --------------------------------------------------
// SHARED HELPERS
// --------------------------------------------------

function getGnaniApiKey() {
  const key = process.env.GNANI_API_KEY_ID;
  return key && key !== "PASTE_YOUR_API_KEY_ID_HERE" ? key : null;
}

function getLanguage(value) {
  const selected = String(value || "").trim().toLowerCase();

  if (
    selected === "en-in" ||
    selected === "en" ||
    selected === "english"
  ) {
    return "en-IN";
  }

  return "hi-IN";
}

function languageInstructions(language) {
  return language === "en-IN"
    ? "Respond entirely in clear, simple Indian English. Do not use Hindi or Hinglish. All user-facing text must be in English."
    : "Respond entirely in simple, natural Hindi using Devanagari script. All user-facing text must be in Hindi. Technical abbreviations such as OTP, UPI, CVV, KYC and SBI may remain in English. Do not write English sentences.";
}

function extractJson(content) {
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("AI returned an empty response.");
  }

  const cleaned = content
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start === -1 || end === -1) {
    throw new Error("AI did not return valid JSON.");
  }

  return JSON.parse(cleaned.slice(start, end + 1));
}

async function callGroq(messages, temperature = 0.2) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is missing in .env");
  }

  const response = await fetch(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-20b",
        temperature,
        messages
      }),
      signal: AbortSignal.timeout(60000)
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error("Groq API error:", response.status, data);
    throw new Error(
      data?.error?.message || `Groq API error: ${response.status}`
    );
  }

  return extractJson(data?.choices?.[0]?.message?.content);
}

// --------------------------------------------------
// CONTEXT-AWARE SAFETY HELPERS
// --------------------------------------------------

function removeSafetyWarningSentences(text) {
  return String(text || "")
    .split(/(?<=[.!?।])\s+|\n+/)
    .filter(sentence => {
      const normalized = sentence.trim();

      const englishWarning =
        /(?:never|do not|don't|dont|should not|shouldn't|must not|avoid)\s+(?:ever\s+)?(?:share|send|tell|reveal|disclose|provide|give|enter|submit)/i.test(normalized);

      const hindiWarning =
        /(?:OTP|UPI\s*PIN|PIN|CVV|ओटीपी|पिन|पासवर्ड|बैंक की जानकारी).{0,60}(?:न\s+बताएं|न\s+बताइए|न\s+दें|न\s+दीजिए|मत बताएं|मत बताइए|मत दें|साझा न करें|शेयर न करें|किसी को न दें|किसी को न बताएं)/i.test(normalized) ||
        /(?:कभी भी|कभी|मत)\s*(?:अपना|अपनी|अपने)?\s*(?:OTP|UPI PIN|PIN|CVV|पासवर्ड|ओटीपी|पिन)?\s*(?:किसी के साथ|किसी को)?\s*(?:शेयर|साझा|बताएं|बताएँ|बताइए|दें|दीजिए)/i.test(normalized);

      return !(englishWarning || hindiWarning);
    })
    .join(" ");
}

// Detect actual requests for sensitive credentials.
// Merely mentioning OTP, PIN, CVV or password is not enough.

function hasCredentialRequest(text) {
  const actionableText = removeSafetyWarningSentences(text);

  const credentialPattern =
    /OTP|one.time.password|UPI\s*PIN|ATM\s*PIN|एटीएम\s*पिन|CVV|password|verification code|ओटीपी|पासवर्ड|पिन/i;

  const requestPattern =
    /share|send|tell|reveal|disclose|provide|give|enter|submit|बताइए|बताएं|बताएँ|बताओ|भेजें|भेजिए|बताना|शेयर करें|साझा करें|दर्ज करें|डालें|लिखें|दे दीजिए|दीजिए/i;

  const sentences = actionableText
    .split(/[.!?।\n]+/)
    .filter(sentence => sentence.trim());

  return sentences.some(sentence =>
    credentialPattern.test(sentence) &&
    requestPattern.test(sentence)
  );
}

// --------------------------------------------------
// BENIGN MESSAGE CONTEXT HELPERS
// --------------------------------------------------

function isBenignInterviewInvitation(text) {
  const lower = String(text || "").toLowerCase();

  const mentionsInterview =
    /\b(interview|technical interview|interview invitation|schedule an interview)\b/i.test(lower);

  const hasNormalInvitation =
    /\b(invite you|invitation|confirm your availability|reply with your availability|look forward to speaking)\b/i.test(lower);

  const hasDangerousRequest =
    /\b(registration fee|processing fee|pay now|transfer money|share your otp|share your password|install anydesk|install teamviewer|remote access|upi pin|cvv)\b/i.test(lower) ||
    /https?:\/\/|www\./i.test(lower);

  return mentionsInterview && hasNormalInvitation && !hasDangerousRequest;
}

function isBenignBankAlert(text) {
  const lower = String(text || "").toLowerCase();

  const mentionsTransaction =
    /\b(transaction|debited|debit card|withdrawal|amount was deducted)\b/i.test(lower);

  const hasVerificationAdvice =
    /\b(if you (?:do not|don't) recognize|if this wasn't you|if you did not make this transaction)\b/i.test(lower);

  const directsToOfficialChannel =
    /\b(official (?:banking )?app|official website|bank's official app|banking application)\b/i.test(lower);

  const hasDangerousRequest =
    hasCredentialRequest(text) ||
    /\b(send money|transfer money|pay now|scan.{0,10}qr|install anydesk|install teamviewer|remote access)\b/i.test(lower) ||
    /https?:\/\/|www\./i.test(lower);

  return (
    mentionsTransaction &&
    hasVerificationAdvice &&
    directsToOfficialChannel &&
    !hasDangerousRequest
  );
}

// --------------------------------------------------
// HEALTH CHECK
// --------------------------------------------------

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "ScamBrake server is running",
    groqConfigured: Boolean(process.env.GROQ_API_KEY),
    gnaniConfigured: Boolean(getGnaniApiKey())
  });
});

// --------------------------------------------------
// PRISMA SPEECH TO TEXT
// --------------------------------------------------

app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      error: "Please upload an audio file."
    });
  }

  const filePath = req.file.path;

  try {
    const apiKey = getGnaniApiKey();

    if (!apiKey) {
      return res.status(500).json({
        success: false,
        error: "Configure GNANI_API_KEY_ID in .env first."
      });
    }

    const audioBuffer = await fs.readFile(filePath);
    const form = new FormData();

    form.append(
      "audio_file",
      new Blob([audioBuffer], {
        type: req.file.mimetype || "application/octet-stream"
      }),
      req.file.originalname
    );

    form.append("language_code", getLanguage(req.body.language_code));
    form.append("format", "transcribe");
    form.append("itn_native_numerals", "true");

    const response = await fetch("https://api.vachana.ai/stt/v3", {
      method: "POST",
      headers: {
        "X-API-Key-ID": apiKey
      },
      body: form,
      signal: AbortSignal.timeout(90000)
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error("Prisma API error:", response.status, result);

      return res.status(502).json({
        success: false,
        error: "Transcription failed. Check the server terminal."
      });
    }

    return res.json({
      success: true,
      transcript: result.transcript ?? "",
      request_id: result.request_id ?? null
    });

  } catch (error) {
    console.error("Transcription error:", error.message);

    return res.status(500).json({
      success: false,
      error: "Could not process audio. Check the server terminal."
    });

  } finally {
    await fs.unlink(filePath).catch(() => {});
  }
});

// --------------------------------------------------
// TIMBRE TEXT TO SPEECH
// --------------------------------------------------

async function translateToHindi(text) {
  const response = await fetch(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-20b",
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: `
Translate the supplied safety guidance into simple, natural spoken Hindi.
Use Devanagari script.
Preserve all safety instructions and emergency numbers.
Do not add or remove important information.
Return only translated Hindi text, without headings or explanations.
`
          },
          {
            role: "user",
            content: text
          }
        ]
      }),
      signal: AbortSignal.timeout(60000)
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data?.error?.message || "Hindi translation failed.");
  }

  const translated = data?.choices?.[0]?.message?.content?.trim();

  if (!translated) {
    throw new Error("Hindi translation was empty.");
  }

  return translated;
}

app.post("/api/speak", async (req, res) => {
  try {
    const apiKey = getGnaniApiKey();
    const { text } = req.body;
    const language = getLanguage(req.body.language);

    if (!apiKey) {
      return res.status(500).json({
        success: false,
        error: "Configure GNANI_API_KEY_ID in .env first."
      });
    }

    if (language === "hi-IN" && !process.env.GROQ_API_KEY) {
      return res.status(500).json({
        success: false,
        error: "Configure GROQ_API_KEY in .env first."
      });
    }

    if (typeof text !== "string" || !text.trim()) {
      return res.status(400).json({
        success: false,
        error: "Please provide text to convert into speech."
      });
    }

    if (text.length > 3000) {
      return res.status(400).json({
        success: false,
        error: "Text must not exceed 3000 characters."
      });
    }

    const speechText = language === "hi-IN"
      ? await translateToHindi(text.trim())
      : text.trim();

    const voice = language === "hi-IN" ? "Chitra" : "Yashvi";

    console.log(`Generating ${language} voice guidance using Timbre...`);

    const response = await fetch(
      "https://api.vachana.ai/api/v1/tts/inference",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key-ID": apiKey
        },
        body: JSON.stringify({
          text: speechText,
          voice,
          model: "timbre-v2.5",
          language,
          speed: 1,
          audio_config: {
            encoding: "linear_pcm",
            container: "wav",
            num_channels: 1,
            sample_rate: 48000,
            sample_width: 2
          }
        }),
        signal: AbortSignal.timeout(90000)
      }
    );

    if (!response.ok) {
      const details = await response.text();
      console.error("Timbre API error:", response.status, details);

      return res.status(502).json({
        success: false,
        error: "Voice generation failed. Check the server terminal."
      });
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());

    if (!audioBuffer.length) {
      return res.status(502).json({
        success: false,
        error: "Timbre returned empty audio."
      });
    }

    res.setHeader("Content-Type", "audio/wav");
    res.setHeader(
      "Content-Disposition",
      'inline; filename="scambrake-guidance.wav"'
    );
    res.setHeader("Content-Length", audioBuffer.length);

    return res.send(audioBuffer);

  } catch (error) {
    console.error("Timbre voice error:", error.message);

    return res.status(500).json({
      success: false,
      error: "Could not generate voice guidance. Check the server terminal."
    });
  }
});

// --------------------------------------------------
// RULE-BASED ANALYSIS
// --------------------------------------------------

function runRuleBasedAnalysis(text, language) {
  const hindi = language === "hi-IN";

  const actionableText = removeSafetyWarningSentences(text);

  const credentialRequest = hasCredentialRequest(text);

  const rules = [
    {
      type: hindi
        ? "ओटीपी और गोपनीय जानकारी माँगने से जुड़ी धोखाधड़ी"
        : "OTP / Credential Request Scam",
      pattern: /NEVER_MATCH_THIS_PATTERN/i,
      enabled: credentialRequest,
      risk: "HIGH",
      reason: hindi
        ? "संदेश में OTP या बैंक की गोपनीय जानकारी साझा करने के लिए कहा गया है।"
        : "The message directly asks the recipient to disclose sensitive credentials.",
      actions: hindi
        ? [
            "अपना OTP, UPI PIN, CVV या पासवर्ड किसी के साथ साझा न करें।",
            "अगर कोई व्यक्ति ये जानकारी माँगे, तो बातचीत बंद कर दें।",
            "अपने बैंक की आधिकारिक ऐप या वेबसाइट से जानकारी की पुष्टि करें।"
          ]
        : [
            "Never share OTP, UPI PIN, CVV or passwords.",
            "Stop the conversation if someone requests these details.",
            "Verify the request through your bank's official app or website."
          ]
    },
    {
      type: hindi
        ? "डर या जल्दबाजी दिखाकर धोखाधड़ी"
        : "Urgency / Threat Scam",
      pattern: /account.{0,50}(block|suspend|close)|digital arrest|police.{0,30}arrest|arrest.{0,30}immediately|(?:खाता|अकाउंट|बैंक खाता).{0,60}(?:बंद|ब्लॉक|सीज|निलंबित)|(?:बंद|ब्लॉक).{0,60}(?:खाता|अकाउंट)|गिरफ्तार|डिजिटल अरेस्ट/i,
      risk: "HIGH",
      reason: hindi
        ? "संदेश में डर या धमकी देकर आप पर तुरंत कार्रवाई करने का दबाव बनाया जा रहा है।"
        : "The message uses a threat or fear to pressure the recipient into acting.",
      actions: hindi
        ? [
            "डर या दबाव में आकर कोई कदम न उठाएँ।",
            "किसी अनजान धमकी से बचने के लिए पैसे न भेजें।",
            "संबंधित दावे की आधिकारिक माध्यम से स्वतंत्र रूप से पुष्टि करें।"
          ]
        : [
            "Do not act under pressure or fear.",
            "Do not pay money to avoid an unexpected threat.",
            "Verify the claim independently through official channels."
          ]
    },
    {
      type: hindi
        ? "भुगतान और UPI से जुड़ी धोखाधड़ी"
        : "Payment / UPI Scam",
      pattern: /send money|transfer money|upi collect|scan.{0,10}qr|payment required|pay.{0,30}(?:fee|charge|amount)|पैसे भेज|पैसा ट्रांसफर|क्यूआर/i,
      risk: "HIGH",
      reason: hindi
        ? "संदेश में पैसे भेजने या भुगतान करने के लिए कहा गया है।"
        : "The message asks the recipient to make a payment or transfer money.",
      actions: hindi
        ? [
            "बिना जाँच किए किसी अनजान UPI कलेक्ट रिक्वेस्ट को स्वीकार न करें।",
            "भुगतान करने से पहले प्राप्तकर्ता और रकम की जाँच करें।",
            "पैसे प्राप्त करने के लिए कभी भी QR कोड स्कैन करके UPI PIN न डालें।"
          ]
        : [
            "Do not approve unexpected UPI collect requests.",
            "Check the recipient and amount before paying.",
            "Never scan a QR code to receive money."
          ]
    },
    {
      type: hindi
        ? "रिमोट एक्सेस से जुड़ी धोखाधड़ी"
        : "Remote Access Scam",
      pattern: /anydesk|teamviewer|quicksupport|remote access|screen share|share the session id|install this app|रिमोट एक्सेस|स्क्रीन शेयर/i,
      risk: "HIGH",
      reason: hindi
        ? "संदेश में आपके डिवाइस का रिमोट एक्सेस लेने या स्क्रीन साझा करवाने की कोशिश की जा रही है।"
        : "The message asks the recipient to grant remote access or share their screen.",
      actions: hindi
        ? [
            "किसी अनजान व्यक्ति के कहने पर रिमोट कंट्रोल ऐप इंस्टॉल न करें।",
            "अनजान व्यक्ति के साथ अपनी स्क्रीन या session ID साझा न करें।",
            "अगर एक्सेस दे दिया है, तो उसे बंद करें और जरूरत पड़ने पर बैंक से संपर्क करें।"
          ]
        : [
            "Do not install remote-control apps at an unknown caller's request.",
            "Do not share your screen or session ID with unknown people.",
            "If access was granted, disconnect it and contact your bank if needed."
          ]
    },
    {
      type: hindi
        ? "संदिग्ध लिंक से जुड़ी धोखाधड़ी"
        : "Suspicious Link",
      pattern: /https?:\/\/\S+|www\.\S+|click this link|link par click/i,
      risk: "MEDIUM",
      reason: hindi
        ? "संदेश में एक लिंक दिया गया है या उस पर क्लिक करने के लिए कहा गया है।"
        : "A link or request to open a link was detected. Its authenticity should be verified.",
      actions: hindi
        ? [
            "अनजान संदेशों में दिए गए लिंक न खोलें।",
            "किसी अप्रमाणित वेबसाइट पर बैंक की जानकारी दर्ज न करें।",
            "बैंक की आधिकारिक ऐप या वेबसाइट का सीधे इस्तेमाल करें।"
          ]
        : [
            "Do not open unexpected links.",
            "Never enter banking details on an unverified website.",
            "Use the official app or website directly."
          ]
    },
    {
      type: hindi
        ? "नकली नौकरी और अग्रिम शुल्क धोखाधड़ी"
        : "Fake Job / Advance Fee Scam",
      pattern: /registration fee|processing fee|activation fee|refundable fee|pay.{0,30}(?:employee id|job|position)|रजिस्ट्रेशन फीस|प्रोसेसिंग फीस/i,
      risk: "HIGH",
      reason: hindi
        ? "नौकरी देने या कर्मचारी ID सक्रिय करने से पहले पैसे माँगे जा रहे हैं।"
        : "The message demands an upfront fee to obtain a job or activate an employee ID.",
      actions: hindi
        ? [
            "नौकरी पाने के लिए किसी अनजान व्यक्ति को अग्रिम शुल्क न दें।",
            "कंपनी की आधिकारिक careers website पर नौकरी की पुष्टि करें।",
            "भर्ती करने वाले की पहचान और ईमेल डोमेन की जाँच करें।"
          ]
        : [
            "Do not pay an upfront fee to obtain a job.",
            "Verify the vacancy on the company's official careers website.",
            "Check the recruiter's identity and email domain."
          ]
    },
    {
      type: hindi
        ? "नकली डिलीवरी शुल्क और कार्ड जानकारी की धोखाधड़ी"
        : "Fake Delivery / Card Phishing Scam",
      pattern: /redelivery fee|delivery fee|reschedule.{0,30}parcel|card number.{0,40}(?:expiry|cvv)|cvv.{0,30}payment|पार्सल.{0,30}शुल्क/i,
      risk: "HIGH",
      reason: hindi
        ? "डिलीवरी के नाम पर भुगतान या कार्ड की गोपनीय जानकारी माँगी जा रही है।"
        : "The message uses a delivery issue to request payment or sensitive card details.",
      actions: hindi
        ? [
            "अनजान डिलीवरी लिंक पर भुगतान या कार्ड की जानकारी दर्ज न करें।",
            "कूरियर की आधिकारिक वेबसाइट या ऐप पर tracking status देखें।",
            "डिलीवरी की पुष्टि अपने आधिकारिक order details से करें।"
          ]
        : [
            "Do not enter card details or pay through an unexpected delivery link.",
            "Check tracking on the courier's official website or app.",
            "Verify the delivery using your original order details."
          ]
    }
  ];

  const detected = rules.filter(rule =>
    rule.enabled === true ||
    (
      rule.enabled !== false &&
      rule.pattern.test(actionableText)
    )
  );

  const riskLevel = detected.some(rule => rule.risk === "HIGH")
    ? "HIGH"
    : detected.length
      ? "MEDIUM"
      : "LOW";

  return {
    success: true,
    analysis_type: "RULE_BASED",
    risk_level: riskLevel,
    scam_types: detected.map(rule => rule.type),
    warning_signs: detected.map(rule => rule.reason),
    recommended_actions: [
      ...new Set(detected.flatMap(rule => rule.actions))
    ],
    explanation: detected.length
      ? hindi
        ? "संदेश में कुछ संदिग्ध संकेत मिले हैं। किसी भी कार्रवाई से पहले संबंधित जानकारी की आधिकारिक माध्यम से पुष्टि करें।"
        : "Suspicious patterns were detected. Verify the conversation independently."
      : hindi
        ? "दिए गए नियमों के आधार पर कोई स्पष्ट चेतावनी संकेत नहीं मिला। इसका अर्थ यह नहीं है कि संदेश पूरी तरह सुरक्षित है।"
        : "No clear warning pattern was detected. This does not prove the message is safe."
  };
}

// --------------------------------------------------
// GROQ MESSAGE ANALYSIS
// --------------------------------------------------

async function runGroqAnalysis(text, language) {
  const result = await callGroq([
    {
      role: "system",
      content: `
You are ScamBrake, an Indian cyber fraud detection assistant.

${languageInstructions(language)}

Analyze SMS, WhatsApp messages, payment requests and suspicious conversations.

Identify possible OTP fraud, UPI fraud, bank KYC scams, digital arrest scams,
fake customer care, phishing links, job and lottery scams, remote access fraud
and payment fraud.

Return ONLY valid JSON:
{
  "risk_level": "HIGH",
  "scam_types": [],
  "warning_signs": [],
  "recommended_actions": [],
  "explanation": ""
}

IMPORTANT CONTEXT RULES:

1. Distinguish between REQUESTING credentials and WARNING users not to share credentials.
2. A message saying "Never share your OTP, PIN or password" is a safety warning,
   NOT an OTP or credential scam.
3. A message mentioning a transaction and advising the user to verify it
   through the official banking app is not automatically a scam.
4. A normal interview invitation is not automatically a job scam.
5. Missing company names, generic greetings or missing phone numbers alone
   are not proof of fraud.
6. Do not classify a message as HIGH without concrete evidence of harmful
   requests, threats, deception or suspicious payment instructions.
7. Do not treat every mention of OTP, PIN, CVV, password or bank details
   as a request to disclose them.
8. Do not assume that a link is fraudulent just because it exists.
9. If the message is harmless but the sender is unverified, use LOW and
   explain that the sender's identity should be verified.
10. If evidence is genuinely unclear, use MEDIUM rather than HIGH.
11. Do not invent evidence.
12. Give practical safety actions based on the actual message.
13. All human-readable text must follow the requested language.
14. If Hindi is requested, every value must be in Devanagari Hindi.
15. Technical terms such as OTP, UPI PIN, CVV, SBI and KYC may remain in English.
16. JSON keys must remain in English.
17. Return JSON only.
`
    },
    {
      role: "user",
      content: text
    }
  ]);

  if (!["HIGH", "MEDIUM", "LOW"].includes(result.risk_level)) {
    throw new Error("Groq returned an invalid risk level.");
  }

  return {
    success: true,
    analysis_type: "GROQ_AI",
    risk_level: result.risk_level,
    scam_types: Array.isArray(result.scam_types)
      ? result.scam_types.filter(x => typeof x === "string")
      : [],
    warning_signs: Array.isArray(result.warning_signs)
      ? result.warning_signs.filter(x => typeof x === "string")
      : [],
    recommended_actions: Array.isArray(result.recommended_actions)
      ? result.recommended_actions.filter(x => typeof x === "string")
      : [],
    explanation: typeof result.explanation === "string"
      ? result.explanation
      : "Analysis completed."
  };
}

// --------------------------------------------------
// COMBINED ANALYSIS
// --------------------------------------------------

async function getCombinedAnalysis(text, language) {
  const ruleResult = runRuleBasedAnalysis(text, language);

  try {
    const aiResult = await runGroqAnalysis(text, language);

    if (
      ruleResult.risk_level === "LOW" &&
      isBenignInterviewInvitation(text)
    ) {
      return {
        success: true,
        language,
        analysis_type: "CONTEXT_AWARE_ANALYSIS",
        risk_level: "LOW",
        scam_types: [],
        warning_signs: language === "hi-IN"
          ? ["भेजने वाले की पहचान की पुष्टि करना उचित रहेगा।"]
          : ["The sender's identity should be verified before proceeding."],
        recommended_actions: language === "hi-IN"
          ? [
              "भेजने वाले के ईमेल पते और कंपनी की आधिकारिक वेबसाइट की जाँच करें।",
              "बिना पुष्टि किए कोई निजी या वित्तीय जानकारी साझा न करें।"
            ]
          : [
              "Check the sender's email address and the company's official website.",
              "Do not share personal or financial information before verifying the sender."
            ],
        explanation: language === "hi-IN"
          ? "यह एक सामान्य इंटरव्यू आमंत्रण जैसा दिखता है। संदेश में कोई स्पष्ट भुगतान या गोपनीय जानकारी माँगने का संकेत नहीं मिला।"
          : "This looks like a normal interview invitation. No clear request for payment or sensitive credentials was detected."
      };
    }

    if (
      ruleResult.risk_level === "LOW" &&
      isBenignBankAlert(text)
    ) {
      return {
        success: true,
        language,
        analysis_type: "CONTEXT_AWARE_ANALYSIS",
        risk_level: "LOW",
        scam_types: [],
        warning_signs: [],
        recommended_actions: language === "hi-IN"
          ? [
              "लेनदेन की पुष्टि अपने बैंक की आधिकारिक ऐप में करें।",
              "अगर लेनदेन आपका नहीं है, तो बैंक की आधिकारिक वेबसाइट या ऐप पर दिए गए संपर्क विवरण से बैंक को सूचित करें।",
              "किसी के साथ अपना OTP, UPI PIN या CVV साझा न करें।"
            ]
          : [
              "Verify the transaction in your bank's official app.",
              "If you did not make the transaction, contact your bank using details on its official website or app.",
              "Never share your OTP, UPI PIN or CVV with anyone."
            ],
        explanation: language === "hi-IN"
          ? "यह एक सामान्य बैंक लेनदेन अलर्ट जैसा दिखता है। संदेश में किसी गोपनीय जानकारी को साझा करने या भुगतान करने की माँग नहीं की गई है।"
          : "This looks like a normal bank transaction alert. It does not ask the recipient to share credentials or make a payment."
      };
    }

    const order = {
      LOW: 1,
      MEDIUM: 2,
      HIGH: 3
    };

    let finalRisk;

    if (ruleResult.risk_level === "HIGH") {
      finalRisk = "HIGH";
    } else if (ruleResult.risk_level === "MEDIUM") {
      finalRisk = order[aiResult.risk_level] > order.MEDIUM
        ? "HIGH"
        : "MEDIUM";
    } else {
      finalRisk = aiResult.risk_level === "HIGH"
        ? "MEDIUM"
        : aiResult.risk_level;
    }

    if (language === "hi-IN") {
      return {
        success: true,
        language: "hi-IN",
        analysis_type: "GROQ_RISK_WITH_HINDI_RULES",
        risk_level: finalRisk,
        scam_types: ruleResult.scam_types,
        warning_signs: ruleResult.warning_signs,
        recommended_actions: ruleResult.recommended_actions,
        explanation: ruleResult.explanation
      };
    }

    return {
      success: true,
      language: "en-IN",
      analysis_type: "GROQ_AI_WITH_RULES",
      risk_level: finalRisk,
      scam_types: [
        ...new Set([
          ...aiResult.scam_types,
          ...ruleResult.scam_types
        ])
      ],
      warning_signs: [
        ...new Set([
          ...aiResult.warning_signs,
          ...ruleResult.warning_signs
        ])
      ],
      recommended_actions: [
        ...new Set([
          ...aiResult.recommended_actions,
          ...ruleResult.recommended_actions
        ])
      ],
      explanation: aiResult.explanation
    };

  } catch (error) {
    console.error("Groq analysis failed:", error.message);

    if (
      ruleResult.risk_level === "LOW" &&
      isBenignInterviewInvitation(text)
    ) {
      return {
        success: true,
        language,
        analysis_type: "CONTEXT_AWARE_RULE_FALLBACK",
        risk_level: "LOW",
        scam_types: [],
        warning_signs: [],
        recommended_actions: language === "hi-IN"
          ? ["भेजने वाले के ईमेल पते और कंपनी की आधिकारिक वेबसाइट की जाँच करें।"]
          : ["Verify the sender's email address and the company's official website."],
        explanation: language === "hi-IN"
          ? "यह सामान्य इंटरव्यू आमंत्रण जैसा दिखता है। भेजने वाले की पहचान की पुष्टि करें।"
          : "This looks like a normal interview invitation. Verify the sender's identity."
      };
    }

    if (
      ruleResult.risk_level === "LOW" &&
      isBenignBankAlert(text)
    ) {
      return {
        success: true,
        language,
        analysis_type: "CONTEXT_AWARE_RULE_FALLBACK",
        risk_level: "LOW",
        scam_types: [],
        warning_signs: [],
        recommended_actions: language === "hi-IN"
          ? ["अपने बैंक की आधिकारिक ऐप में लेनदेन की पुष्टि करें।"]
          : ["Verify the transaction in your bank's official app."],
        explanation: language === "hi-IN"
          ? "यह सामान्य बैंक लेनदेन अलर्ट जैसा दिखता है।"
          : "This looks like a normal bank transaction alert."
      };
    }

    return {
      ...ruleResult,
      language,
      analysis_type: "RULE_BASED_FALLBACK"
    };
  }
}

// --------------------------------------------------
// ANALYSE API
// --------------------------------------------------

app.post("/api/analyze", async (req, res) => {
  try {
    const { text } = req.body;
    const language = getLanguage(req.body.language);

    console.log("ANALYSIS LANGUAGE:", language);

    if (typeof text !== "string" || !text.trim()) {
      return res.status(400).json({
        success: false,
        error: "Please provide a message to analyse."
      });
    }

    if (text.length > 10000) {
      return res.status(400).json({
        success: false,
        error: "Message is too long."
      });
    }

    const result = await getCombinedAnalysis(text.trim(), language);

    return res.json(result);

  } catch (error) {
    console.error("Analysis error:", error.message);

    return res.status(500).json({
      success: false,
      error: "Analysis failed."
    });
  }
});

// --------------------------------------------------
// SCAM REPLAY LAB
// --------------------------------------------------

function extractExactRedFlags(original, language) {
  const patterns = language === "hi-IN"
    ? [
        {
          pattern: /आज ही/gi,
          explanation: "संदेश में तुरंत कार्रवाई करने का दबाव बनाया जा रहा है।"
        },
        {
          pattern: /बैंक अकाउंट बंद हो सकता है/gi,
          explanation: "अकाउंट बंद होने का डर दिखाकर आपको जल्दबाजी में निर्णय लेने के लिए मजबूर किया जा रहा है।"
        },
        {
          pattern: /अपना OTP बताइए/gi,
          explanation: "बैंक कर्मचारी बनकर OTP माँगना एक गंभीर धोखाधड़ी का संकेत है।"
        },
        {
          pattern: /OTP/gi,
          explanation: "OTP से जुड़ी जानकारी माँगना गंभीर सुरक्षा जोखिम है। अपना OTP किसी के साथ साझा न करें।"
        },
        {
          pattern: /तुरंत/gi,
          explanation: "तुरंत कार्रवाई करने के लिए दबाव बनाया जा रहा है।"
        },
        {
          pattern: /KYC अपडेट नहीं हुआ है/gi,
          explanation: "KYC अधूरा होने का दावा करके बातचीत को विश्वसनीय दिखाने की कोशिश की जा रही है।"
        },
        {
          pattern: /खाता बंद/gi,
          explanation: "खाता बंद होने की धमकी देकर डर पैदा किया जा रहा है।"
        }
      ]
    : [
        {
          pattern: /your bank account may be blocked/gi,
          explanation: "The caller threatens account blockage to create fear and pressure you into acting quickly."
        },
        {
          pattern: /please share your OTP/gi,
          explanation: "The caller is directly asking for an OTP, which should never be shared with anyone."
        },
        {
          pattern: /OTP/gi,
          explanation: "Any request to disclose an OTP should be treated with extreme caution."
        },
        {
          pattern: /immediately/gi,
          explanation: "This word creates pressure to act without verifying the request."
        },
        {
          pattern: /today/gi,
          explanation: "The caller creates a false sense of urgency by setting a same-day deadline."
        },
        {
          pattern: /KYC verification is incomplete/gi,
          explanation: "The caller uses an incomplete KYC claim to make the request appear legitimate."
        },
        {
          pattern: /account will be blocked/gi,
          explanation: "The message uses the threat of account blockage to create fear."
        }
      ];

  const found = [];

  for (const item of patterns) {
    const matches = original.match(item.pattern) || [];

    for (const phrase of matches) {
      if (!found.some(
        flag => flag.phrase.toLowerCase() === phrase.toLowerCase()
      )) {
        found.push({
          phrase,
          why_it_matters: item.explanation
        });
      }
    }
  }

  return found;
}

app.post("/api/replay-analysis", async (req, res) => {
  try {
    const { text, analysis } = req.body;
    const language = getLanguage(req.body.language);

    if (typeof text !== "string" || !text.trim() || text.length > 10000) {
      return res.status(400).json({
        success: false,
        error: "Please provide a valid message."
      });
    }

    if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) {
      return res.status(400).json({
        success: false,
        error: "A valid conversation analysis is required."
      });
    }

    const safeAnalysis = {
      risk_level: ["HIGH", "MEDIUM", "LOW"].includes(analysis.risk_level)
        ? analysis.risk_level
        : "UNKNOWN",

      scam_types: Array.isArray(analysis.scam_types)
        ? analysis.scam_types.filter(x => typeof x === "string").slice(0, 10)
        : [],

      warning_signs: Array.isArray(analysis.warning_signs)
        ? analysis.warning_signs.filter(x => typeof x === "string").slice(0, 15)
        : [],

      recommended_actions: Array.isArray(analysis.recommended_actions)
        ? analysis.recommended_actions.filter(x => typeof x === "string").slice(0, 15)
        : [],

      explanation: typeof analysis.explanation === "string"
        ? analysis.explanation.slice(0, 1500)
        : ""
    };

    const original = text.trim();

    const result = await callGroq([
      {
        role: "system",
        content: `
You are Scam Replay Lab, an Indian cyber safety assistant.

${languageInstructions(language)}

Explain manipulation tactics and warning signs in the supplied message.

Return ONLY JSON:
{
  "tactics": [
    {
      "name": "Urgency or fear",
      "evidence": "Exact words from original message",
      "explanation": "Explanation"
    }
  ],
  "red_flags": [
    {
      "phrase": "Exact original phrase",
      "why_it_matters": "Explanation"
    }
  ],
  "possible_consequences": [
    "A conditional possible consequence."
  ],
  "safe_response": [
    "A practical safety action."
  ],
  "confidence_note": "Limits of this analysis."
}

IMPORTANT RULES:

1. Every red_flags.phrase MUST be copied exactly from the original message.
2. Do not paraphrase or invent evidence.
3. Identify clear suspicious phrases such as:
   - Requests for OTP or banking credentials.
   - Threats of account blockage.
   - Pressure to act immediately.
   - Artificial deadlines.
4. Do not return an empty red_flags array when clear suspicious phrases exist.
5. Explain why each exact phrase is suspicious.
6. Do not assume the recipient clicked a link, shared credentials,
   installed an app or transferred money.
7. Explain consequences conditionally and specifically.
8. Do not claim an account will be blocked merely because a suspicious
   message is ignored.
9. Never invent, guess or provide any bank phone number or helpline number.
10. For bank verification, instruct the user to use the bank's official
    website, official mobile app or contact details printed on their bank card.
11. Do not repeat sensitive credentials.
12. Do not recommend paying money to resolve a threat.
13. All human-readable text must follow the requested language.
14. If Hindi is requested, use Devanagari Hindi for explanations.
    Exact evidence phrases must remain unchanged from the original message.
15. JSON keys must remain in English.
16. Return JSON only.
`
      },
      {
        role: "user",
        content:
          `ORIGINAL MESSAGE:\n${original}\n\nEXISTING ANALYSIS:\n${JSON.stringify(safeAnalysis)}`
      }
    ]);

    const tactics = Array.isArray(result.tactics)
      ? result.tactics
          .filter(x =>
            x &&
            typeof x.name === "string" &&
            typeof x.explanation === "string"
          )
          .slice(0, 5)
          .map(x => ({
            name: x.name.slice(0, 100),

            evidence:
              typeof x.evidence === "string" &&
              x.evidence.trim() &&
              original.includes(x.evidence)
                ? x.evidence
                : "",

            explanation: x.explanation.slice(0, 500)
          }))
      : [];

    const aiRedFlags = Array.isArray(result.red_flags)
      ? result.red_flags
          .filter(x =>
            x &&
            typeof x.phrase === "string" &&
            typeof x.why_it_matters === "string" &&
            x.phrase.trim() &&
            original.includes(x.phrase)
          )
          .map(x => ({
            phrase: x.phrase,
            why_it_matters: x.why_it_matters.slice(0, 500)
          }))
      : [];

    const ruleRedFlags = extractExactRedFlags(original, language);
    const combinedFlags = [...aiRedFlags];

    for (const flag of ruleRedFlags) {
      const alreadyExists = combinedFlags.some(
        existing =>
          existing.phrase.toLowerCase() === flag.phrase.toLowerCase()
      );

      if (!alreadyExists) {
        combinedFlags.push(flag);
      }
    }

    const redFlags = combinedFlags.slice(0, 8);

    const consequences = Array.isArray(result.possible_consequences)
      ? result.possible_consequences
          .filter(x =>
            typeof x === "string" &&
            x.trim() &&
            (
              /\b(if|could|may|might|would|can)\b|अगर|यदि|होने पर|करने पर|सकता|सकती|संभव है/i.test(x)
            ) &&
            !(
              /\b(account|bank account)\b/i.test(x) &&
              /\b(blocked|blocking|suspended|suspension)\b/i.test(x)
            )
          )
          .slice(0, 5)
      : [];

    let safeResponse = Array.isArray(result.safe_response)
      ? result.safe_response
          .filter(x => typeof x === "string" && x.trim())
          .slice(0, 6)
      : [];

    const containsPhoneNumber = value =>
      /(?:\+?\d[\d\s().\-–—‑]{7,}\d)/.test(value);

    const hadUnverifiedNumber = safeResponse.some(
      containsPhoneNumber
    );

    safeResponse = safeResponse.filter(
      x => !containsPhoneNumber(x)
    );

    const hasOfficialVerification = safeResponse.some(
      x => /official|website|app|bank card|आधिकारिक|वेबसाइट|ऐप|बैंक कार्ड/i.test(x)
    );

    if (!hasOfficialVerification) {
      safeResponse.push(
        language === "hi-IN"
          ? "बैंक की जानकारी की पुष्टि उसकी आधिकारिक वेबसाइट, ऐप या बैंक कार्ड पर दिए गए संपर्क विवरण से करें।"
          : "Verify the claim using contact details listed on the bank's official website, app or bank card."
      );
    }

    return res.json({
      success: true,
      language,
      analysis_type: "SCAM_REPLAY_LAB",
      risk_level: safeAnalysis.risk_level,
      tactics,
      red_flags: redFlags,
      possible_consequences: consequences,
      safe_response: safeResponse,
      confidence_note:
        typeof result.confidence_note === "string"
          ? result.confidence_note.slice(0, 500)
          : language === "hi-IN"
            ? "यह AI की सहायता से किया गया विश्लेषण है, धोखाधड़ी होने का निश्चित प्रमाण नहीं।"
            : "This is an AI-supported explanation, not proof that fraud occurred."
    });

  } catch (error) {
    console.error("Scam Replay Lab error:", error.message);

    return res.status(500).json({
      success: false,
      error: "Scam Replay Lab could not generate an explanation. Please try again."
    });
  }
});

// --------------------------------------------------
// SCAM RECOVERY ASSISTANT
// --------------------------------------------------

function explicitlyDeniedMoneyTransfer(value) {
  return /(?:did not|didn't|never|have not|haven't|no)\s+(?:send|sent|transfer|transferred|pay|paid|lose|lost)|(?:नहीं|नही)\s*(?:भेजा|भेजे|किया|गए|हुए)|पैसे भी नहीं/i.test(value);
}

function explicitlyDeniedCredentialSharing(value) {
  return /(?:did not|didn't|never|have not|haven't|not)\s+(?:share|shared|give|gave|provide|provided|disclose)|(?:नहीं|नही)\s*(?:बताया|दिया|साझा)|नहीं साझा/i.test(value);
}

// --------------------------------------------------
// RECOVERY ASSISTANT API
// --------------------------------------------------

app.post("/api/situation-assistant", async (req, res) => {
  try {
    const { text, situation, customSituation } = req.body;
    const language = getLanguage(req.body.language);

    const validSituations = [
      "nothing_done",
      "shared_otp",
      "shared_bank_details",
      "sent_money",
      "clicked_link",
      "installed_app",
      "account_hacked",
      "threatened_blackmailed",
      "other"
    ];

    if (
      typeof text !== "string" ||
      !text.trim() ||
      !validSituations.includes(situation)
    ) {
      return res.status(400).json({
        success: false,
        error: "Please provide the message and select a valid situation."
      });
    }

    if (text.length > 10000) {
      return res.status(400).json({
        success: false,
        error: "Message is too long."
      });
    }

    if (
      situation === "other" &&
      (typeof customSituation !== "string" || !customSituation.trim())
    ) {
      return res.status(400).json({
        success: false,
        error: "Please describe what happened in your situation."
      });
    }

    if (
      typeof customSituation === "string" &&
      customSituation.length > 1500
    ) {
      return res.status(400).json({
        success: false,
        error: "Custom situation must not exceed 1500 characters."
      });
    }

    const labels = {
      nothing_done: "The user has not taken any action yet.",
      shared_otp: "The user shared an OTP, UPI PIN or password.",
      shared_bank_details: "The user shared bank or card details.",
      sent_money: "The user transferred money.",
      clicked_link: "The user clicked a suspicious link.",
      installed_app: "The user installed an unknown or remote access app, or shared their screen.",
      account_hacked: "The user's account may have been hacked or taken over.",
      threatened_blackmailed: "The user is being threatened, intimidated or blackmailed.",
      other: `The user described their situation as: ${String(customSituation || "").trim()}`
    };

    const incidentText = [
      text.trim(),
      situation === "other" ? customSituation.trim() : ""
    ].filter(Boolean).join("\n");

    const result = await callGroq([
      {
        role: "system",
        content: `
You are ScamBrake, an Indian cyber fraud recovery and safety assistant.

${languageInstructions(language)}

Your job is to give calm, accurate, situation-specific next steps.
Understand what ACTUALLY happened before recommending any action.

Return ONLY valid JSON:
{
  "situation_summary": "Short explanation",
  "immediate_steps": ["Step 1", "Step 2", "Step 3"],
  "prevention_tip": "One useful safety tip",
  "emergency_advice": "Relevant emergency guidance or an empty string"
}

IMPORTANT DECISION RULES:

1. If the user received a suspicious call/message but did NOT share information,
   did NOT approve a payment and did NOT transfer money:
   - Do not describe the user as a victim of financial loss.
   - Do not tell them to freeze their account or change all passwords without reason.
   - Recommend ending the call, blocking/reporting the number if appropriate,
     independently verifying the claim through the bank's official app or website,
     and monitoring account activity.
   - Do not recommend calling 1930 or filing an emergency complaint as a necessary step.
   - emergency_advice must be an empty string unless there is a genuine separate emergency.

2. If money was actually transferred or an unauthorized transaction occurred:
   - Advise contacting the bank immediately through its official contact details.
   - Advise calling India's cyber-fraud helpline 1930 promptly.
   - Mention cybercrime.gov.in for reporting.
   - Explain that quick reporting may help, but never promise recovery.

3. If an OTP, UPI PIN, password or banking credentials were actually shared:
   - Recommend contacting the bank through official channels immediately.
   - Change affected credentials through official channels using a trusted device.
   - Never ask the user to reveal any OTP, PIN, CVV or password.

4. If only a suspicious link was clicked:
   - Do not assume the account or device is compromised.
   - Ask no questions in the output.
   - Advise closing the page and not entering information or downloading anything.
   - Recommend further action only if the user actually entered credentials,
     downloaded an app or noticed suspicious activity.

5. If a remote-access app was installed or screen access was granted:
   - Advise ending the remote session and disconnecting access.
   - Remove the suspicious app safely.
   - Contact the bank if financial apps or accounts were accessible.

6. If an account was actually hacked:
   - Recommend official account recovery from a trusted device.
   - Change affected credentials and enable two-factor authentication.

7. If the user is threatened or blackmailed:
   - Advise preserving evidence, not paying, and not sharing more information.
   - Recommend reporting to the appropriate authority.
   - Mention emergency services only if there is immediate physical danger.

8. Do not give the same generic five steps to every user.
9. Give 2 to 5 short, practical steps. Avoid repetitive steps.
10. Do not invent a bank helpline number. Tell users to obtain verified contact details
    from the bank's official website, official app or bank card.
11. Do not claim that a bank account will be blocked merely because a suspicious call is ignored.
12. Do not recommend 1930 for a suspicious call alone when no financial loss or
    unauthorized transaction has occurred.
13. Do not recommend police or emergency services when the user has not described
    a threat, crime requiring reporting or immediate danger.
14. Do not assume that the user shared information just because someone asked for it.
15. If the user explicitly says they did not share credentials or transfer money,
    respect that fact.
16. Do not invent facts or claim that the user's account is safe with certainty.
17. All human-readable text must follow the selected language.
18. If Hindi is selected, all user-facing text must be in Devanagari Hindi.
19. If English is selected, all user-facing text must be in English.
20. JSON keys must remain in English. Return JSON only.
`
      },
      {
        role: "user",
        content: `
INCIDENT MESSAGE:
${text.trim()}

SELECTED SITUATION:
${labels[situation]}

ADDITIONAL DETAILS:
${situation === "other" ? customSituation.trim() : "No additional custom details."}

Give guidance for this exact incident. Distinguish between what the caller
asked the user to do and what the user actually did.
Do not assume that requested actions were completed.
`
      }
    ]);

    if (
      typeof result.situation_summary !== "string" ||
      !Array.isArray(result.immediate_steps) ||
      typeof result.prevention_tip !== "string" ||
      typeof result.emergency_advice !== "string"
    ) {
      throw new Error("Invalid guidance format.");
    }

    let summary = result.situation_summary.trim();
    let steps = result.immediate_steps
      .filter(x => typeof x === "string" && x.trim())
      .slice(0, 5);

    let preventionTip = result.prevention_tip.trim();
    let emergencyAdvice = result.emergency_advice.trim();

    const deniedMoney = explicitlyDeniedMoneyTransfer(incidentText);
    const deniedCredentials = explicitlyDeniedCredentialSharing(incidentText);

    const actualMoneyLoss =
      situation === "sent_money" ||
      (
        !deniedMoney &&
        /\b(money was transferred|transferred money|sent money|made a payment|unauthorized transaction|money was debited|amount was deducted|lost money)\b|पैसे ट्रांसफर हो गए|पैसे कट गए|रकम कट गई/i.test(incidentText)
      );

    const actualCredentialSharing =
      situation === "shared_otp" ||
      situation === "shared_bank_details" ||
      (
        !deniedCredentials &&
        /\b(shared my otp|shared the otp|gave my otp|shared my password|shared my pin|shared my cvv|entered my banking details|shared my bank details)\b|ओटीपी बता दिया|ओटीपी साझा किया|पासवर्ड बता दिया|पिन बता दिया/i.test(incidentText)
      );

    const actualThreat =
      situation === "threatened_blackmailed" ||
      /\b(threatened me|blackmailed me|physical threat|threatening to hurt|demanding money to stay silent)\b|धमकी दी|ब्लैकमेल/i.test(incidentText);

    if (
      situation === "other" &&
      deniedMoney &&
      deniedCredentials &&
      !actualThreat
    ) {
      if (language === "en-IN") {
        summary =
          "You received a suspicious call from someone claiming to be an SBI bank employee. You did not share your OTP or banking details, and no money was transferred.";

        steps = [
          "End the call and do not respond to further requests for OTPs or banking details.",
          "Block the suspicious number if the caller continues contacting you.",
          "If you want to verify the KYC claim, contact SBI using the contact details on its official website or app.",
          "Keep the call details and monitor your bank account for any unexpected activity."
        ];

        preventionTip =
          "Never share your OTP, UPI PIN, CVV or password with anyone, even if they claim to be calling from your bank.";

        emergencyAdvice = "";
      } else {
        summary =
          "आपको SBI कर्मचारी बनकर किसी व्यक्ति का संदिग्ध कॉल आया। आपने अपना OTP या बैंक की जानकारी साझा नहीं की और कोई पैसा ट्रांसफर नहीं हुआ।";

        steps = [
          "कॉल काट दें और आगे किसी को भी OTP या बैंक की जानकारी न दें।",
          "अगर कॉल करने वाला बार-बार संपर्क करे, तो उसका नंबर ब्लॉक कर दें।",
          "अगर KYC की पुष्टि करनी है, तो SBI की आधिकारिक वेबसाइट या ऐप पर दिए गए संपर्क विवरण का इस्तेमाल करें।",
          "कॉल की तारीख, समय और नंबर सुरक्षित रखें तथा अपने बैंक खाते की गतिविधियों पर नज़र रखें।"
        ];

        preventionTip =
          "किसी भी व्यक्ति को अपना OTP, UPI PIN, CVV या पासवर्ड न बताएं, भले ही वह खुद को बैंक कर्मचारी बताए।";

        emergencyAdvice = "";
      }
    }

    if (!actualMoneyLoss && !actualCredentialSharing) {
      const unnecessaryFinancialAdvice = language === "en-IN"
        ? /1930|cybercrime\.gov\.in|money recovery|freeze your account|financial loss/i
        : /1930|cybercrime\.gov\.in|पैसे वापस|खाता फ्रीज़|वित्तीय नुकसान/i;

      steps = steps.filter(step => !unnecessaryFinancialAdvice.test(step));
      emergencyAdvice = emergencyAdvice
        .replace(unnecessaryFinancialAdvice, "")
        .trim();
    }

    if (!actualThreat) {
      const unnecessaryEmergencyAdvice = language === "en-IN"
        ? /local police|police station|emergency services|call the police|physical danger/i
        : /पुलिस|आपातकालीन सेवा|आपात स्थिति/i;

      steps = steps.filter(step => !unnecessaryEmergencyAdvice.test(step));

      if (unnecessaryEmergencyAdvice.test(emergencyAdvice)) {
        emergencyAdvice = "";
      }
    }

    return res.json({
      success: true,
      language,
      analysis_type: "GROQ_SITUATION_ASSISTANT",
      situation_summary: summary,
      immediate_steps: steps,
      prevention_tip: preventionTip,
      emergency_advice: emergencyAdvice
    });

  } catch (error) {
    console.error("Situation Assistant error:", error.message);

    return res.status(500).json({
      success: false,
      error: "Situation guidance could not be generated."
    });
  }
});

// --------------------------------------------------
// 404 + GLOBAL ERROR HANDLER
// --------------------------------------------------

app.use("/api", (req, res) => {
  res.status(404).json({
    success: false,
    error: "API route not found.",
    requestedPath: req.originalUrl,
    method: req.method
  });
});

app.use((error, req, res, next) => {
  console.error("Global server error:", error.message);

  if (res.headersSent) return next(error);

  const status =
    error instanceof multer.MulterError &&
    error.code === "LIMIT_FILE_SIZE"
      ? 413
      : error.status || 500;

  res.status(status).json({
    success: false,
    error: status === 413
      ? "Audio file exceeds the 15 MB limit."
      : error.message || "Internal server error."
  });
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

app.listen(PORT, () => {
  console.log("------------------------------------");
  console.log("ScamBrake server running");
  console.log(`http://localhost:${PORT}`);
  console.log("Groq:", process.env.GROQ_API_KEY ? "Configured" : "Missing");
  console.log("Gnani:", getGnaniApiKey() ? "Configured" : "Missing");
  console.log("------------------------------------");
});
