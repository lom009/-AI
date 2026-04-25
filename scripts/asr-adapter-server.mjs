import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { WebSocket } from "ws";

const rootDir = path.resolve(new URL("..", import.meta.url).pathname);
const staticDir = path.join(
  rootDir,
  "case-outputs",
  "PDA护患对话AI填表",
  "nursing-pda-ai-pol-prototype-execution"
);
const envPath = process.env.ASR_ENV_PATH || path.join(rootDir, ".secrets", "tencent-asr.env");
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "127.0.0.1";
const maxBodyBytes = 12 * 1024 * 1024;
const tencentChunkBytes = 6400;
const tencentChunkIntervalMs = 200;

const sampleTranscripts = {
  "ADM-001": "护士：阿姨，您以前有没有药物过敏？患者：有的，我以前打青霉素后起过红疹，医生说以后别用。护士：现在有没有哪里疼？患者：右膝盖疼，差不多六分，走路更明显。护士：去年有没有摔倒过？患者：去年冬天在家里滑倒过一次，没有骨折。护士：现在在吃什么药？患者：平时吃降压药，名字我记不清。",
  "ADM-002": "护士：您有没有药物或者食物过敏？患者：没有，药物过敏没有。护士：以前有什么慢性病？患者：糖尿病十来年了。护士：平时用什么药？患者：二甲双胍，一天两次。护士：最近睡眠怎么样？患者：晚上睡得不好，醒好几次。护士：疼痛有吗？患者：没有明显疼痛。",
  "ADM-003": "护士：您平时吃什么药？患者：我不太记得，都是女儿给我拿。家属：有降压药，还有一种保护心脏的。护士：有没有过敏？患者：海鲜吃了会痒，药物好像没有。护士：最近走路稳不稳？家属：她这两个月腿软，差点摔过两回。护士：疼痛几分？患者：腰有点酸，三四分吧。"
};

function parseEnv(text) {
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      })
  );
}

async function loadEnvSafe() {
  try {
    return { ...parseEnv(await readFile(envPath, "utf8")), ...process.env };
  } catch {
    return { ...process.env };
  }
}

function mask(value, keepStart = 4, keepEnd = 4) {
  if (!value) return "";
  if (value.length <= keepStart + keepEnd) return "*".repeat(value.length);
  return `${value.slice(0, keepStart)}${"*".repeat(Math.min(12, value.length - keepStart - keepEnd))}${value.slice(-keepEnd)}`;
}

function buildTencentSignedUrl(env) {
  const appId = env.TENCENT_APP_ID;
  const secretId = env.TENCENT_SECRET_ID;
  const secretKey = env.TENCENT_SECRET_KEY;
  if (!appId || !secretId || !secretKey) {
    return { ok: false, missing: ["TENCENT_APP_ID", "TENCENT_SECRET_ID", "TENCENT_SECRET_KEY"].filter((key) => !env[key]) };
  }

  const now = Math.floor(Date.now() / 1000);
  const params = {
    engine_model_type: env.TENCENT_ASR_ENGINE_MODEL_TYPE || "16k_zh",
    expired: String(now + 86400),
    needvad: env.TENCENT_ASR_NEED_VAD || "1",
    nonce: String(Math.floor(Math.random() * 1000000000)),
    secretid: secretId,
    timestamp: String(now),
    voice_format: env.TENCENT_ASR_VOICE_FORMAT || "1",
    voice_id: crypto.randomUUID()
  };
  const canonicalQuery = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
  const hostAndPath = `asr.cloud.tencent.com/asr/v2/${appId}`;
  const signature = crypto.createHmac("sha1", secretKey).update(`${hostAndPath}?${canonicalQuery}`).digest("base64");
  const signedUrl = `wss://${hostAndPath}?${canonicalQuery}&signature=${encodeURIComponent(signature)}`;

  return {
    ok: true,
    signedUrl,
    appId: mask(appId, 3, 3),
    secretId: mask(secretId),
    engineModelType: params.engine_model_type,
    voiceFormat: params.voice_format,
    needVad: params.needvad,
    voiceId: params.voice_id,
    signedUrlMasked: signedUrl.replace(secretId, mask(secretId)).replace(encodeURIComponent(signature), "<masked-signature>")
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function messageDataToText(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  if (typeof data?.text === "function") return data.text();
  return String(data);
}

function tencentPayloadToSegment(payload) {
  const result = payload?.result;
  if (!result || typeof result.voice_text_str !== "string") return null;
  const text = result.voice_text_str.trim();
  if (!text) return null;
  return {
    segmentId: `seg-${String(Number(result.index || 0) + 1).padStart(3, "0")}`,
    text,
    isFinal: result.slice_type === 2 || payload.final === 1,
    startMs: Number(result.start_time || 0),
    endMs: Number(result.end_time || 0),
    confidence: 0.82,
    speaker: "unknown",
    index: Number(result.index || 0),
    sliceType: result.slice_type
  };
}

function normalizeTencentMessages(messages) {
  const finalByIndex = new Map();
  for (const message of messages) {
    const result = message.result;
    if (!result || typeof result.voice_text_str !== "string") continue;
    if (result.slice_type === 2 || result.slice_type === undefined) {
      const text = result.voice_text_str.trim();
      if (text) finalByIndex.set(result.index ?? finalByIndex.size, result);
    }
  }

  return [...finalByIndex.entries()]
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([index, result]) => ({
      segmentId: `seg-${String(Number(index) + 1).padStart(3, "0")}`,
      text: result.voice_text_str,
      isFinal: true,
      startMs: Number(result.start_time || 0),
      endMs: Number(result.end_time || 0),
      confidence: 0.82,
      speaker: "unknown"
    }));
}

async function transcribeTencentPcm(pcmBuffer, env) {
  const signed = buildTencentSignedUrl(env);
  if (!signed.ok) {
    throw new Error(`Tencent ASR credentials missing: ${signed.missing.join(", ")}`);
  }
  if (!pcmBuffer.length) {
    throw new Error("No PCM audio payload received.");
  }

  const messages = [];
  const startedAt = Date.now();
  const chunks = [];
  for (let offset = 0; offset < pcmBuffer.length; offset += tencentChunkBytes) {
    chunks.push(pcmBuffer.subarray(offset, offset + tencentChunkBytes));
  }

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(signed.signedUrl);
    let settled = false;
    let opened = false;
    let sentAudio = false;
    const timer = setTimeout(() => {
      finish(new Error("Tencent ASR timed out before final result."));
    }, Math.max(15000, chunks.length * tencentChunkIntervalMs + 12000));

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // Ignore close errors after resolution.
      }
      if (error) reject(error);
      else resolve(value);
    }

    async function sendAudioChunks() {
      try {
        for (const chunk of chunks) {
          if (ws.readyState !== WebSocket.OPEN) break;
          ws.send(chunk);
          await delay(tencentChunkIntervalMs);
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "end" }));
        }
      } catch (error) {
        finish(error);
      }
    }

    ws.addEventListener("open", () => {
      opened = true;
    });

    ws.addEventListener("message", async (event) => {
      try {
        const text = await messageDataToText(event.data);
        const payload = JSON.parse(text);
        messages.push(payload);
        if (payload.code && payload.code !== 0) {
          finish(new Error(`Tencent ASR error ${payload.code}: ${payload.message || "unknown error"}`));
          return;
        }
        if (opened && !sentAudio && payload.code === 0 && payload.message === "success" && !payload.result && !payload.final) {
          sentAudio = true;
          sendAudioChunks();
          return;
        }
        if (payload.final === 1) {
          finish(null, {
            provider: "tencent_asr",
            mode: "streaming_websocket",
            voiceId: signed.voiceId,
            latencyMs: Date.now() - startedAt,
            messagesReceived: messages.length,
            segments: normalizeTencentMessages(messages)
          });
        }
      } catch (error) {
        finish(error);
      }
    });

    ws.addEventListener("error", () => {
      finish(new Error("Tencent ASR WebSocket connection failed."));
    });

    ws.addEventListener("close", () => {
      if (!settled) {
        const segments = normalizeTencentMessages(messages);
        if (segments.length) {
          finish(null, {
            provider: "tencent_asr",
            mode: "streaming_websocket",
            voiceId: signed.voiceId,
            latencyMs: Date.now() - startedAt,
            messagesReceived: messages.length,
            segments
          });
        } else {
          finish(new Error("Tencent ASR connection closed without final transcript."));
        }
      }
    });
  });
}

function splitTurnsToSegments(transcript, provider) {
  const matches = [...transcript.matchAll(/(护士|患者|家属)[：:]\s*([^：:]+?)(?=\s*(护士|患者|家属)[：:]|$)/g)];
  const turns = matches.length
    ? matches.map((match) => ({ speaker: match[1], text: match[2].trim() }))
    : transcript.split(/[。！？?；;]/).map((text) => ({ speaker: "unknown", text: text.trim() })).filter((turn) => turn.text);

  let cursor = 0;
  return turns.filter((turn) => turn.text).map((turn, index) => {
    const duration = Math.max(900, Math.min(5200, turn.text.length * 180));
    const segment = {
      segmentId: `seg-${String(index + 1).padStart(3, "0")}`,
      text: turn.text,
      isFinal: true,
      startMs: cursor,
      endMs: cursor + duration,
      confidence: provider === "mock" ? 0.92 : 0.78,
      speaker: turn.speaker
    };
    cursor += duration + 180;
    return segment;
  });
}

function createWsFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const length = body.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, body]);
}

function sendWsJson(socket, body) {
  if (socket.destroyed) return;
  socket.write(createWsFrame(0x1, JSON.stringify(body)));
}

function sendWsClose(socket) {
  if (socket.destroyed) return;
  socket.end(createWsFrame(0x8));
}

function parseClientWsFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (offset + 4 > buffer.length) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (offset + 10 > buffer.length) break;
      const bigLength = buffer.readBigUInt64BE(offset + 2);
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("WebSocket frame too large.");
      length = Number(bigLength);
      headerLength = 10;
    }
    const maskLength = masked ? 4 : 0;
    const frameStart = offset + headerLength + maskLength;
    const frameEnd = frameStart + length;
    if (frameEnd > buffer.length) break;
    let payload = buffer.subarray(frameStart, frameEnd);
    if (masked) {
      const mask = buffer.subarray(offset + headerLength, offset + headerLength + 4);
      payload = Buffer.from(payload);
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }
    frames.push({ opcode, payload });
    offset = frameEnd;
  }
  return { frames, remaining: buffer.subarray(offset) };
}

async function handleRealtimeUpgrade(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "\r\n"
  ].join("\r\n"));

  const env = await loadEnvSafe();
  let upstream = null;
  let clientBuffer = Buffer.alloc(0);
  let upstreamReady = false;
  let upstreamClosed = false;
  const pendingAudio = [];

  function closeUpstream() {
    upstreamClosed = true;
    if (upstream && upstream.readyState === WebSocket.OPEN) {
      upstream.close();
    }
  }

  function flushPendingAudio() {
    if (!upstreamReady || !upstream || upstream.readyState !== WebSocket.OPEN) return;
    while (pendingAudio.length) upstream.send(pendingAudio.shift());
  }

  function openTencentStream(startMessage) {
    const signed = buildTencentSignedUrl(env);
    if (!signed.ok) {
      sendWsJson(socket, {
        type: "error",
        code: "TENCENT_CREDENTIALS_MISSING",
        message: `Tencent ASR credentials missing: ${signed.missing.join(", ")}`
      });
      return;
    }

    upstream = new WebSocket(signed.signedUrl);
    sendWsJson(socket, {
      type: "adapter_ready",
      provider: "tencent_asr",
      mode: "realtime_websocket_proxy",
      scenarioId: startMessage.scenarioId || "ADM-001",
      sampleRate: Number(startMessage.sampleRate || env.TENCENT_ASR_SAMPLE_RATE || 16000),
      voiceId: signed.voiceId
    });

    upstream.addEventListener("message", async (event) => {
      try {
        const text = await messageDataToText(event.data);
        const payload = JSON.parse(text);
        if (payload.code && payload.code !== 0) {
          sendWsJson(socket, { type: "error", code: "TENCENT_ASR_ERROR", message: payload.message || `Tencent ASR error ${payload.code}` });
          return;
        }
        if (payload.code === 0 && payload.message === "success" && !payload.result && !payload.final) {
          upstreamReady = true;
          sendWsJson(socket, { type: "asr_ready" });
          flushPendingAudio();
          return;
        }
        const segment = tencentPayloadToSegment(payload);
        if (segment) {
          sendWsJson(socket, { type: segment.isFinal ? "segment_final" : "segment_partial", segment, raw: payload });
        }
        if (payload.final === 1) {
          sendWsJson(socket, { type: "stream_final" });
          sendWsClose(socket);
        }
      } catch (error) {
        sendWsJson(socket, { type: "error", code: "TENCENT_MESSAGE_PARSE_FAILED", message: error.message });
      }
    });

    upstream.addEventListener("error", () => {
      sendWsJson(socket, { type: "error", code: "TENCENT_WEBSOCKET_ERROR", message: "Tencent ASR WebSocket connection failed." });
    });

    upstream.addEventListener("close", () => {
      if (!upstreamClosed) sendWsJson(socket, { type: "upstream_closed" });
    });
  }

  socket.on("data", (chunk) => {
    try {
      clientBuffer = Buffer.concat([clientBuffer, chunk]);
      const parsed = parseClientWsFrames(clientBuffer);
      clientBuffer = parsed.remaining;
      for (const frame of parsed.frames) {
        if (frame.opcode === 0x8) {
          closeUpstream();
          sendWsClose(socket);
          return;
        }
        if (frame.opcode === 0x9) {
          socket.write(createWsFrame(0xA, frame.payload));
          continue;
        }
        if (frame.opcode === 0x1) {
          const message = JSON.parse(frame.payload.toString("utf8"));
          if (message.type === "start") {
            openTencentStream(message);
          } else if (message.type === "end") {
            if (upstream && upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify({ type: "end" }));
            sendWsJson(socket, { type: "stream_ending" });
            setTimeout(() => {
              if (!socket.destroyed) closeUpstream();
            }, 12000);
          }
          continue;
        }
        if (frame.opcode === 0x2) {
          if (upstreamReady && upstream && upstream.readyState === WebSocket.OPEN) {
            upstream.send(frame.payload);
          } else {
            pendingAudio.push(frame.payload);
          }
        }
      }
    } catch (error) {
      sendWsJson(socket, { type: "error", code: "REALTIME_PROXY_ERROR", message: error.message });
    }
  });

  socket.on("close", closeUpstream);
  socket.on("error", closeUpstream);
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(payload);
}

function sendError(res, statusCode, code, message) {
  sendJson(res, statusCode, { error: { code, message } });
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      throw new Error("REQUEST_TOO_LARGE");
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function getMimeType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".env") || filePath.endsWith(".example")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

async function serveStatic(req, res, url) {
  const requestedPath = decodeURIComponent(url.pathname === "/" ? "/high-fidelity-prototype.html" : url.pathname);
  const normalized = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const target = path.join(staticDir, normalized);
  if (!target.startsWith(staticDir)) {
    sendError(res, 403, "FORBIDDEN", "Invalid path.");
    return;
  }
  try {
    const info = await stat(target);
    if (!info.isFile()) {
      sendError(res, 404, "NOT_FOUND", "File not found.");
      return;
    }
    const content = await readFile(target);
    res.writeHead(200, {
      "Content-Type": getMimeType(target),
      "Content-Length": content.length,
      "X-Content-Type-Options": "nosniff",
      "Access-Control-Allow-Origin": "*"
    });
    res.end(content);
  } catch {
    sendError(res, 404, "NOT_FOUND", "File not found.");
  }
}

async function handleHealth(res) {
  const env = await loadEnvSafe();
  const signed = buildTencentSignedUrl(env);
  sendJson(res, 200, {
    ok: true,
    provider: env.ASR_PROVIDER || "mock",
    mode: env.ASR_MODE || "file",
    tencent: {
      configured: signed.ok,
      appId: env.TENCENT_APP_ID ? mask(env.TENCENT_APP_ID, 3, 3) : "",
      hasSecretId: Boolean(env.TENCENT_SECRET_ID),
      hasSecretKey: Boolean(env.TENCENT_SECRET_KEY),
      engineModelType: env.TENCENT_ASR_ENGINE_MODEL_TYPE || "16k_zh",
      voiceFormat: env.TENCENT_ASR_VOICE_FORMAT || "1",
      sampleRate: Number(env.TENCENT_ASR_SAMPLE_RATE || 16000),
      missing: signed.ok ? [] : signed.missing
    },
    safety: {
      allowRealPatientAudio: env.ALLOW_REAL_PATIENT_AUDIO === "true",
      logAudioPayload: env.LOG_AUDIO_PAYLOAD === "true",
      secretsInResponse: false
    }
  });
}

async function handleSignedUrlCheck(res) {
  const env = await loadEnvSafe();
  const signed = buildTencentSignedUrl(env);
  if (!signed.ok) {
    sendJson(res, 200, { ok: false, missing: signed.missing });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    appId: signed.appId,
    secretId: signed.secretId,
    engineModelType: signed.engineModelType,
    voiceFormat: signed.voiceFormat,
    needVad: signed.needVad,
    voiceId: signed.voiceId,
    signedUrlMasked: signed.signedUrlMasked
  });
}

async function handleTranscribe(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const message = error.message === "REQUEST_TOO_LARGE" ? "Audio payload is too large." : "Invalid JSON body.";
    sendError(res, 400, "BAD_REQUEST", message);
    return;
  }

  const scenarioId = typeof body.scenarioId === "string" ? body.scenarioId : "ADM-001";
  const audioBase64 = typeof body.audioBase64 === "string" ? body.audioBase64 : "";
  const mimeType = typeof body.mimeType === "string" ? body.mimeType.slice(0, 80) : "unknown";
  const audioEncoding = typeof body.audioEncoding === "string" ? body.audioEncoding.slice(0, 40) : "";
  const useRealAsr = body.useRealAsr === true;
  const audioBytes = audioBase64 ? Math.floor((audioBase64.length * 3) / 4) : 0;

  if (audioBase64 && !/^[A-Za-z0-9+/=]+$/.test(audioBase64)) {
    sendError(res, 400, "BAD_AUDIO_PAYLOAD", "audioBase64 must be base64 encoded audio bytes.");
    return;
  }

  const env = await loadEnvSafe();
  const signed = buildTencentSignedUrl(env);
  const canUseTencent = signed.ok && audioEncoding === "pcm_s16le" && Boolean(audioBase64);
  if (useRealAsr && canUseTencent) {
    try {
      const pcmBuffer = Buffer.from(audioBase64, "base64");
      const tencentResult = await transcribeTencentPcm(pcmBuffer, env);
      sendJson(res, 200, {
        provider: tencentResult.provider,
        mode: tencentResult.mode,
        scenarioId,
        input: {
          audioBytes,
          mimeType,
          audioEncoding,
          sampleRate: Number(body.sampleRate || env.TENCENT_ASR_SAMPLE_RATE || 16000)
        },
        tencent: {
          configured: true,
          websocketReady: true,
          realRequest: true,
          signedUrlMasked: signed.signedUrlMasked,
          voiceId: tencentResult.voiceId,
          latencyMs: tencentResult.latencyMs,
          messagesReceived: tencentResult.messagesReceived,
          missing: []
        },
        segments: tencentResult.segments,
        adapterNote: "Tencent realtime WebSocket returned transcript_segments."
      });
      return;
    } catch (error) {
      const transcript = sampleTranscripts[scenarioId] || sampleTranscripts["ADM-001"];
      sendJson(res, 200, {
        provider: "tencent_asr_error_mock_fallback",
        mode: body.mode || "streaming",
        scenarioId,
        input: {
          audioBytes,
          mimeType,
          audioEncoding,
          sampleRate: Number(body.sampleRate || env.TENCENT_ASR_SAMPLE_RATE || 16000)
        },
        tencent: {
          configured: signed.ok,
          websocketReady: signed.ok,
          realRequest: true,
          signedUrlMasked: signed.ok ? signed.signedUrlMasked : "",
          missing: signed.ok ? [] : signed.missing,
          error: error.message
        },
        segments: splitTurnsToSegments(transcript, "mock"),
        adapterNote: "Tencent realtime WebSocket failed; returned mock segments so the PM flow can continue."
      });
      return;
    }
  }

  const transcript = sampleTranscripts[scenarioId] || sampleTranscripts["ADM-001"];
  const provider = signed.ok ? "tencent_asr_adapter_ready_mock_result" : "mock_asr";

  sendJson(res, 200, {
    provider,
    mode: body.mode || "file",
    scenarioId,
    input: {
      audioBytes,
      mimeType,
      audioEncoding,
      sampleRate: Number(body.sampleRate || env.TENCENT_ASR_SAMPLE_RATE || 16000)
    },
    tencent: {
      configured: signed.ok,
      websocketReady: signed.ok,
      signedUrlMasked: signed.ok ? signed.signedUrlMasked : "",
      missing: signed.ok ? [] : signed.missing
    },
    segments: splitTurnsToSegments(transcript, signed.ok ? "tencent" : "mock"),
    adapterNote: signed.ok
      ? "Tencent credentials are configured. Send pcm_s16le audio with useRealAsr=true to call Tencent realtime WebSocket."
      : "Tencent credentials are incomplete, so the adapter returned mock segments."
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end();
    return;
  }

  try {
    if (req.method === "GET" && url.pathname === "/api/asr/health") {
      await handleHealth(res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/asr/tencent/signed-url-check") {
      await handleSignedUrlCheck(res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/asr/transcribe") {
      await handleTranscribe(req, res);
      return;
    }
    if (req.method === "GET") {
      await serveStatic(req, res, url);
      return;
    }
    sendError(res, 405, "METHOD_NOT_ALLOWED", "Method not allowed.");
  } catch {
    sendError(res, 500, "INTERNAL_ERROR", "Unexpected adapter error.");
  }
});

server.on("upgrade", async (req, socket) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/api/asr/realtime") {
    socket.destroy();
    return;
  }
  try {
    await handleRealtimeUpgrade(req, socket);
  } catch (error) {
    try {
      socket.end();
    } catch {
      // Ignore close errors during failed upgrade.
    }
  }
});

server.listen(port, host, () => {
  console.log(`ASR Adapter listening on http://${host}:${port}/high-fidelity-prototype.html`);
  console.log("Secrets stay in environment variables or .secrets/tencent-asr.env and are not served to the browser.");
});
