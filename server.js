import { createReadStream, readFileSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5178);
const HOST = process.env.HOST || "127.0.0.1";
const DEFAULT_IMAGE_MODEL = "gpt-image-2";
const DEFAULT_VISION_MODEL = "gpt-5.5";

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml; charset=utf-8"],
]);

const samples = {
  "white-hooded": "generated_model_images/white_plush_hooded_jacket_model_20260622.png",
  "white-vneck": "generated_model_images/white_plush_vneck_jacket_model_20260622.png",
  "camel-short": "generated_model_images/camel_plush_short_jacket_model_20260622.png",
  "brown-mink": "output/model-look-brown-mink-quiet-luxury.png",
};

loadLocalEnv();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/api/status") {
      return sendJson(res, {
        hasKey: Boolean(process.env.OPENAI_API_KEY),
        imageModel: process.env.OPENAI_IMAGE_MODEL || DEFAULT_IMAGE_MODEL,
        visionModel: process.env.OPENAI_VISION_MODEL || DEFAULT_VISION_MODEL,
      });
    }

    if (req.method === "GET" && url.pathname === "/api/samples") {
      return sendJson(res, {
        samples: Object.entries(samples).map(([id, file]) => ({ id, url: `/sample/${id}`, file })),
      });
    }

    if (req.method === "POST" && url.pathname === "/api/save-key") {
      await handleSaveKey(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/sample/")) {
      const id = decodeURIComponent(url.pathname.replace("/sample/", ""));
      if (!samples[id]) return notFound(res);
      await sendFile(res, path.join(__dirname, samples[id]));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/generate") {
      await handleGenerate(req, res);
      return;
    }

    if (req.method === "GET") {
      const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
      await sendFile(res, path.join(__dirname, "public", safePublicPath(filePath)));
      return;
    }

    sendJson(res, { error: "不支持这个请求。" }, 405);
  } catch (error) {
    console.error(error);
    if (!res.writableEnded) {
      sendJson(res, { error: safeError(error) }, 500);
    }
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.log(`模特图工具已经在运行：http://${HOST}:${PORT}`);
    return;
  }

  console.error(error);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  console.log(`模特图工具已启动：http://${HOST}:${PORT}`);
});

async function handleGenerate(req, res) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return sendJson(
      res,
      {
        error: "还没有连接 OpenAI API key。等密钥补好后，这个按钮就可以直接生成图片。",
        missingKey: true,
      },
      400,
    );
  }

  const incoming = new Request(`http://localhost:${PORT}/api/generate`, {
    method: "POST",
    headers: req.headers,
    body: req,
    duplex: "half",
  });

  const form = await incoming.formData();
  const image = form.get("garment");
  if (!image || typeof image === "string") {
    return sendJson(res, { error: "请先选择一张衣服图片。" }, 400);
  }

  const imageBytes = Buffer.from(await image.arrayBuffer());
  const imageMime = image.type || "image/png";
  const imageDataUrl = `data:${imageMime};base64,${imageBytes.toString("base64")}`;
  const notes = String(form.get("notes") || "").trim();
  const garmentAnalysis = await analyzeGarmentImage({
    apiKey,
    imageDataUrl,
    notes,
  });

  const prompt = buildPrompt({
    notes,
    pose: String(form.get("pose") || "quiet-luxury"),
    garmentAnalysis,
  });

  const imageBlob = new Blob([imageBytes], { type: imageMime });
  const body = new FormData();
  body.append("model", process.env.OPENAI_IMAGE_MODEL || DEFAULT_IMAGE_MODEL);
  body.append("prompt", prompt);
  body.append("size", "1024x1536");
  body.append("quality", "high");
  body.append("output_format", "png");
  body.append("image", imageBlob, cleanFileName(image.name || "garment.png"));

  const response = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return sendJson(
      res,
      {
        error: openAIErrorMessage(data, "生成失败，请检查密钥或图片后再试。"),
      },
      response.status,
    );
  }

  const firstImage = data.data?.[0]?.b64_json;
  if (!firstImage) {
    return sendJson(res, { error: "生成完成但没有收到图片，请再试一次。" }, 502);
  }

  await mkdir(path.join(__dirname, "agent_outputs"), { recursive: true });
  const fileName = `model_photo_${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
  const savedPath = path.join(__dirname, "agent_outputs", fileName);
  await writeFile(savedPath, Buffer.from(firstImage, "base64"));

  sendJson(res, {
    image: `data:image/png;base64,${firstImage}`,
    savedFile: `agent_outputs/${fileName}`,
    analysis: garmentAnalysis,
  });
}

async function analyzeGarmentImage({ apiKey, imageDataUrl, notes }) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_VISION_MODEL || DEFAULT_VISION_MODEL,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: buildAnalysisPrompt(notes) },
            { type: "input_image", image_url: imageDataUrl },
          ],
        },
      ],
      max_output_tokens: 1200,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(openAIErrorMessage(data, "自动分析衣服要素失败，请检查图片或密钥后再试。"));
  }

  const text = data.output_text || extractResponseText(data);
  return normalizeGarmentAnalysis(parseJsonObject(text));
}

async function handleSaveKey(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);

  let payload = {};
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return sendJson(res, { error: "密钥格式没有保存成功。" }, 400);
  }

  const apiKey = String(payload.apiKey || "").trim();
  if (!apiKey.startsWith("sk-") || apiKey.length < 40) {
    return sendJson(res, { error: "这不像一个有效的 OpenAI API key。" }, 400);
  }

  const target = path.join(__dirname, ".env.local");
  let lines = [];
  try {
    lines = readFileSync(target, "utf8").split(/\r?\n/);
  } catch {
    lines = [];
  }

  const withoutKey = lines.filter((line) => !line.trim().startsWith("OPENAI_API_KEY="));
  const withoutModel = withoutKey.filter((line) => !line.trim().startsWith("OPENAI_IMAGE_MODEL="));
  const withoutVision = withoutModel.filter((line) => !line.trim().startsWith("OPENAI_VISION_MODEL="));
  const nextContent = [
    ...withoutVision.filter((line) => line.trim()),
    `OPENAI_API_KEY=${apiKey}`,
    `OPENAI_IMAGE_MODEL=${DEFAULT_IMAGE_MODEL}`,
    `OPENAI_VISION_MODEL=${DEFAULT_VISION_MODEL}`,
    "",
  ].join("\n");

  await writeFile(target, nextContent, { mode: 0o600 });
  process.env.OPENAI_API_KEY = apiKey;
  process.env.OPENAI_IMAGE_MODEL ||= DEFAULT_IMAGE_MODEL;
  process.env.OPENAI_VISION_MODEL ||= DEFAULT_VISION_MODEL;

  sendJson(res, { ok: true, savedTo: ".env.local" });
}

function buildAnalysisPrompt(notes) {
  const extra = notes
    ? `用户补充备注：${notes}`
    : "用户没有补充备注。请只根据图片中主服装分析。";

  return [
    "你是资深电商服装造型师和模特图提示词助手。",
    "请分析上传图片里的主商品服装，不要把背景、衣架、人体姿势或搭配道具当成商品细节。",
    "重点识别：颜色、材质、毛感/面料肌理、衣长、廓形、肩线、领型/帽子、袖型、袖长、袖口、口袋、门襟/扣子/拉链、下摆、拼接线、特殊装饰。",
    "如果某个部位看不清楚，写“未明显可见”，不要编造。",
    extra,
    "",
    "只输出一个 JSON 对象，不要输出 Markdown，不要解释。JSON 字段如下：",
    "{",
    '  "productName": "一句话商品名",',
    '  "productParagraph": "仿照：上身是一件短款白色水貂外套，廓形偏宽松，落肩、袖子蓬松，视觉重点在毛感和厚度。根据图片真实替换颜色、材质、衣长、领型、袖型、口袋等，不要保留示例里没有出现在图片中的内容。",',
    '  "color": "主颜色和辅色",',
    '  "material": "材质/毛感/面料肌理",',
    '  "silhouette": "廓形和松量",',
    '  "length": "衣长",',
    '  "shoulder": "肩线/落肩/正肩",',
    '  "collar": "领型/帽子/翻领/立领/V领等",',
    '  "sleeves": "袖型和袖长",',
    '  "cuffs": "袖口形状和开口",',
    '  "pockets": "口袋位置、角度、类型；没有或看不清就说明",',
    '  "closure": "门襟、扣子、拉链、钩扣等",',
    '  "hem": "下摆形状、厚度、长短",',
    '  "detailsToPreserve": ["必须保留的细节1", "必须保留的细节2"]',
    "}",
  ].join("\n");
}

function buildPrompt({ notes, pose, garmentAnalysis }) {
  const poseLine = {
    "quiet-luxury":
      "竖版全身图，安静奢华街拍感，模特姿态松弛自信，人物居中偏下，上方和右侧留白较多。",
    walking:
      "竖版全身图，自然走路姿势，像生活化街拍，但商品正面、领子、袖口和口袋仍然清楚。",
    "studio-clean":
      "竖版全身图，干净棚拍和暖石材空间结合，画面克制，商品轮廓清楚。",
    "detail-forward":
      "竖版全身或近全身图，手部位置避开关键部位，优先展示领子、袖口、口袋、门襟和下摆。",
  }[pose] || "竖版全身图，安静奢华街拍感，商品清楚。";

  const userNotes = notes
    ? `用户额外备注：${notes}`
    : "用户无额外备注；以上传图片自动解析结果为准。";

  const preserveList = Array.isArray(garmentAnalysis.detailsToPreserve)
    ? garmentAnalysis.detailsToPreserve.map((item) => `- ${item}`).join("\n")
    : "- 按上传图保留真实款式细节";

  return [
    "请根据上传图片生成一张写实高级模特图。上传图片里的主商品服装是唯一款式依据。",
    "",
    "整体风格：",
    "低饱和、复古、松弛感，偏“都市极简 + quiet luxury”。主色控制在棕色、黑色、白色、米灰和暖石材色里，整体统一，不要高饱和颜色。画面像高级生活化街拍，不要廉价影棚感。",
    "",
    "服装解析（根据上传图片自动替换）：",
    garmentAnalysis.productParagraph,
    `颜色：${garmentAnalysis.color}`,
    `材质：${garmentAnalysis.material}`,
    `廓形：${garmentAnalysis.silhouette}`,
    `衣长：${garmentAnalysis.length}`,
    `肩线：${garmentAnalysis.shoulder}`,
    `领子/帽子：${garmentAnalysis.collar}`,
    `袖子：${garmentAnalysis.sleeves}`,
    `袖口：${garmentAnalysis.cuffs}`,
    `口袋：${garmentAnalysis.pockets}`,
    `门襟：${garmentAnalysis.closure}`,
    `下摆：${garmentAnalysis.hem}`,
    "",
    "固定搭配：",
    "内搭使用白色或低对比中性色立领/高领上衣，颜色压低，让主商品更突出。下装使用黑色高腰阔腿长裤，垂坠感强，裤腿很长，覆盖到鞋面。配饰使用黑色单肩包、同色尖头鞋和墨镜，强化黑棕色系穿搭。不要让包、手臂或头发挡住领子、袖口、口袋和门襟。",
    "",
    "画面构图：",
    poseLine,
    "生活化场景，暖米灰石材墙面或都市建筑入口，自然柔光，柔和阴影。人物全身可见，脚和鞋不要被裁掉。上方和右侧保留适度留白，人物比例自然。",
    "",
    "款式锁定，必须严格遵守：",
    "- 领子、帽子、翻领、V领、圆领、立领不能互相改。",
    "- 袖长、袖型、肩线、袖口形状、袖口开口大小必须与上传图一致。",
    "- 口袋位置、角度、开口方向、贴袋/斜插袋/嵌线袋类型必须与上传图一致。",
    "- 门襟、扣子、拉链、钩扣、横向分割、拼接线和下摆必须与上传图一致。",
    "- 不要凭空添加口袋、腰带、抽绳、纽扣、logo 或装饰。",
    "- 图片中看不清的细节保持简单，不要重新设计。",
    "",
    "本次必须保留的细节：",
    preserveList,
    "",
    "输出要求：",
    "写实摄影质感，清晰展示商品毛感/面料厚度/真实穿着比例，无文字、水印、品牌标志，无畸形手指。",
    "",
    userNotes,
  ].join("\n");
}

function parseJsonObject(text) {
  if (!text) throw new Error("自动分析没有返回文字。");
  const cleaned = text.replace(/```json|```/g, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("自动分析结果格式不正确。");
  return JSON.parse(match[0]);
}

function extractResponseText(data) {
  const chunks = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") chunks.push(content.text);
      if (typeof content.output_text === "string") chunks.push(content.output_text);
    }
  }
  return chunks.join("\n").trim();
}

function normalizeGarmentAnalysis(raw) {
  const text = (key, fallback = "未明显可见") => {
    const value = raw?.[key];
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
  };

  const details = Array.isArray(raw?.detailsToPreserve)
    ? raw.detailsToPreserve.filter((item) => typeof item === "string" && item.trim()).slice(0, 10)
    : [];

  return {
    productName: text("productName", "上传图片中的主商品服装"),
    productParagraph: text("productParagraph", "上身主商品以上传图片为准，保持真实颜色、材质、廓形和细节。"),
    color: text("color"),
    material: text("material"),
    silhouette: text("silhouette"),
    length: text("length"),
    shoulder: text("shoulder"),
    collar: text("collar"),
    sleeves: text("sleeves"),
    cuffs: text("cuffs"),
    pockets: text("pockets"),
    closure: text("closure"),
    hem: text("hem"),
    detailsToPreserve: details.length ? details : ["领子、袖口、口袋、门襟和下摆按上传图保持"],
  };
}

function loadLocalEnv() {
  const envPath = path.join(__dirname, ".env.local");
  try {
    const content = readFileSyncSafe(envPath);
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index === -1) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // A missing .env.local is fine; the page will show a friendly status.
  }
}

function readFileSyncSafe(filePath) {
  return readFileSync(filePath, "utf8");
}

function cleanFileName(name) {
  return name.replace(/[^a-z0-9._-]/gi, "_").slice(0, 80) || "garment.png";
}

function safePublicPath(filePath) {
  const normalized = path.normalize(filePath).replace(/^(\.\.[/\\])+/, "");
  return normalized.replace(/^[/\\]/, "");
}

async function sendFile(res, filePath) {
  const resolved = path.resolve(filePath);
  const publicRoot = path.resolve(__dirname, "public");
  const sampleRoot = path.resolve(__dirname);
  if (!resolved.startsWith(publicRoot) && !resolved.startsWith(sampleRoot)) return notFound(res);

  try {
    const fileStat = await stat(resolved);
    if (!fileStat.isFile()) return notFound(res);
  } catch {
    return notFound(res);
  }

  const ext = path.extname(resolved).toLowerCase();
  res.writeHead(200, { "Content-Type": mimeTypes.get(ext) || "application/octet-stream" });
  createReadStream(resolved).pipe(res);
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function notFound(res) {
  sendJson(res, { error: "没有找到这个文件。" }, 404);
}

function safeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function openAIErrorMessage(data, fallback) {
  const rawMessage = data?.error?.message || fallback;
  const code = data?.error?.code || "";
  const status = data?.error?.status || "";
  const combined = `${rawMessage} ${code} ${status}`.toLowerCase();

  if (combined.includes("quota") || combined.includes("billing") || combined.includes("plan")) {
    return "OpenAI API 额度不足或计费未开通。请到 OpenAI Platform 的 Billing/Usage 检查余额、用量限制或绑定付款方式后再试。";
  }

  if (combined.includes("rate limit")) {
    return "请求太频繁了，稍等一会儿再生成。";
  }

  if (combined.includes("model")) {
    return `当前模型不可用：${rawMessage}`;
  }

  return rawMessage;
}
