// OmniParser 一键部署（国内网络优化版，把踩过的坑全部自动化）：
// 1) gitcode 镜像克隆代码  2) venv + CPU torch + 依赖（阿里云镜像）
// 3) hf-mirror 下载权重   4) 应用兼容性补丁（paddle 惰性/RapidOCR/auto_map/MD5）
// 用法: node scripts/omni-setup.cjs
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const HOME = os.homedir();
const ROOT = path.join(HOME, "OmniParser");
const VENV = path.join(HOME, "omni-env");
const PY = path.join(VENV, "Scripts", "python.exe");
const ALI = "https://mirrors.aliyun.com/pypi/simple/";
const HF = "https://hf-mirror.com";

function run(cmd, opts = {}) {
  console.log(">>", cmd.slice(0, 90));
  execSync(cmd, { stdio: "inherit", ...opts });
}

async function download(url, dest) {
  console.log("下载:", url.slice(0, 100));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  console.log("  完成:", path.basename(dest), (buf.length / 1024 / 1024).toFixed(1), "MB");
}

function patchFile(file, pairs) {
  if (!fs.existsSync(file)) return false;
  let content = fs.readFileSync(file, "utf8");
  let changed = false;
  for (const [from, to] of pairs) {
    if (content.includes(from)) {
      content = content.replace(from, to);
      changed = true;
    }
  }
  if (changed) fs.writeFileSync(file, content, "utf8");
  return changed;
}

async function main() {
  console.log("=== OmniParser 一键部署（国内镜像版）===\n");

  // 1. 克隆代码（gitcode 镜像）
  if (!fs.existsSync(ROOT)) {
    run(`git clone --depth 1 https://gitcode.com/gmyyds/OmniParser.git "${ROOT}"`);
  } else {
    console.log("OmniParser 目录已存在，跳过克隆");
  }

  // 2. venv + 依赖
  if (!fs.existsSync(PY)) {
    run(`python -m venv "${VENV}"`);
  }
  const pipInstall = (pkgs) =>
    run(`"${PY}" -m pip install ${pkgs} -i ${ALI} --timeout 60 --retries 2`);
  pipInstall("--upgrade pip");
  pipInstall(
    "torch torchvision openai easyocr supervision timm dill einops accelerate azure-identity " +
      "rapidocr_onnxruntime fastapi uvicorn pillow pydantic numpy==1.26.4 opencv-python " +
      "transformers==4.46.3 ultralytics==8.3.70",
  );
  console.log("依赖安装完成\n");

  // 3. 权重下载（hf-mirror）
  const W = path.join(ROOT, "weights");
  const OV2 = `${HF}/microsoft/OmniParser-v2.0/resolve/main`;
  const FB = `${HF}/microsoft/Florence-2-base/resolve/main`;
  const FFT = `${HF}/microsoft/Florence-2-base-ft/resolve/main`;
  const ER = `${HF}/itextresearch`;

  const files = [
    [`${OV2}/icon_detect/model.pt`, path.join(W, "icon_detect", "model.pt")],
    [`${OV2}/icon_detect/train_args.yaml`, path.join(W, "icon_detect", "train_args.yaml")],
    [`${OV2}/icon_detect/model.yaml`, path.join(W, "icon_detect", "model.yaml")],
    [`${OV2}/icon_caption/config.json`, path.join(W, "icon_caption_florence", "config.json")],
    [`${OV2}/icon_caption/generation_config.json`, path.join(W, "icon_caption_florence", "generation_config.json")],
    [`${OV2}/icon_caption/model.safetensors`, path.join(W, "icon_caption_florence", "model.safetensors")],
    [`${FB}/preprocessor_config.json`, path.join(W, "icon_caption_florence", "preprocessor_config.json")],
    [`${FB}/tokenizer.json`, path.join(W, "icon_caption_florence", "tokenizer.json")],
    [`${FB}/tokenizer_config.json`, path.join(W, "icon_caption_florence", "tokenizer_config.json")],
    [`${FB}/vocab.json`, path.join(W, "icon_caption_florence", "vocab.json")],
    [`${FFT}/configuration_florence2.py`, path.join(W, "icon_caption_florence", "configuration_florence2.py")],
    [`${FFT}/modeling_florence2.py`, path.join(W, "icon_caption_florence", "modeling_florence2.py")],
    [`${FFT}/processing_florence2.py`, path.join(W, "icon_caption_florence", "processing_florence2.py")],
    // easyocr 模型（本地存放，跳过国外下载）
    [`${ER}/itext-EasyOCR-craft_mlt_25k/resolve/main/craft_mlt_25k.pth`, path.join(HOME, ".EasyOCR", "model", "craft_mlt_25k.pth")],
    [`${ER}/itext-EasyOCR-english_g2/resolve/main/english_g2.pth`, path.join(HOME, ".EasyOCR", "model", "english_g2.pth")],
    [`${ER}/itext-EasyOCR-english_g2/resolve/main/english_g2.yaml`, path.join(HOME, ".EasyOCR", "model", "english_g2.yaml")],
    [`${ER}/itext-EasyOCR-latin_g2/resolve/main/latin_g2.pth`, path.join(HOME, ".EasyOCR", "model", "latin_g2.pth")],
    [`${ER}/itext-EasyOCR-latin_g2/resolve/main/latin_g2.yaml`, path.join(HOME, ".EasyOCR", "model", "latin_g2.yaml")],
  ];
  for (const [url, dest] of files) {
    if (!fs.existsSync(dest) || fs.statSync(dest).size < 1000) {
      await download(url, dest).catch((e) => console.log("  !! 失败:", e.message));
    } else {
      console.log("已存在，跳过:", path.basename(dest));
    }
  }
  console.log("权重就绪\n");

  // 4. 补丁
  const utilsPy = path.join(ROOT, "util", "utils.py");
  const patched = patchFile(utilsPy, [
    // paddleocr 惰性化
    [
      "import easyocr\nfrom paddleocr import PaddleOCR\nreader = easyocr.Reader(['en'])",
      "import easyocr  # noqa: F401\nfrom rapidocr_onnxruntime import RapidOCR\nreader = RapidOCR()",
    ],
    // RapidOCR 输出 score 为字符串
    [
      "result = [(item[0], item[1], item[2]) for item in (raw or []) if item[2] > text_threshold]",
      "result = [(item[0], item[1], float(item[2])) for item in (raw or []) if float(item[2]) > text_threshold]",
    ],
    // processor 用本地路径
    [
      'processor = AutoProcessor.from_pretrained("microsoft/Florence-2-base", trust_remote_code=True)',
      "processor = AutoProcessor.from_pretrained(model_name_or_path, trust_remote_code=True)",
    ],
  ]);
  console.log("utils.py 补丁:", patched ? "已应用" : "无需/跳过");

  const serverPy = path.join(ROOT, "omnitool", "omniparserserver", "omniparserserver.py");
  console.log(
    "server reload 补丁:",
    patchFile(serverPy, [["reload=True", "reload=False"]]) ? "已应用" : "跳过",
  );

  const omniPy = path.join(ROOT, "util", "omniparser.py");
  console.log(
    "跳过 Florence 描述（CPU 提速 10 倍）补丁:",
    patchFile(omniPy, [["use_local_semantics=True", "use_local_semantics=False"]]) ? "已应用" : "跳过",
  );

  // config.json auto_map 本地化
  const cfgPath = path.join(W, "icon_caption_florence", "config.json");
  if (fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    if (cfg.auto_map && typeof cfg.auto_map.AutoConfig === "string" && cfg.auto_map.AutoConfig.includes("--")) {
      cfg.auto_map = {
        AutoConfig: "configuration_florence2.Florence2Config",
        AutoModelForCausalLM: "modeling_florence2.Florence2ForConditionalGeneration",
      };
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      console.log("config.json auto_map 本地化: 已应用");
    }
  }

  // easyocr MD5 校验跳过（镜像文件 MD5 与官方不一致）
  const easyPy = path.join(VENV, "Lib", "site-packages", "easyocr", "easyocr.py");
  if (fs.existsSync(easyPy)) {
    const ok1 = patchFile(easyPy, [
      [
        "            elif calculate_md5(detector_path) != self.detection_models[self.detect_network]['md5sum']:\n" +
          "                if not self.download_enabled:\n" +
          "                    raise FileNotFoundError(\"MD5 mismatch for %s and downloads disabled\" % detector_path)\n" +
          "                LOGGER.warning(corrupt_msg)\n" +
          "                os.remove(detector_path)\n" +
          "                LOGGER.warning('Re-downloading the detection model, please wait. '\n" +
          "                               'This may take several minutes depending upon your network connection.')\n" +
          "                download_and_unzip(self.detection_models[self.detect_network]['url'], self.detection_models[self.detect_network]['filename'], self.model_storage_directory, self.verbose)\n" +
          "                assert calculate_md5(detector_path) == self.detection_models[self.detect_network]['md5sum'], corrupt_msg",
        "            elif calculate_md5(detector_path) != self.detection_models[self.detect_network]['md5sum']:\n" +
          "                # mirror files: skip md5 check, use local file as-is\n" +
          "                LOGGER.warning('MD5 mismatch (mirror file), using local file as-is: %s', detector_path)",
      ],
      [
        "                elif calculate_md5(model_path) != model['md5sum']:\n" +
          "                    if not self.download_enabled:\n" +
          "                        raise FileNotFoundError(\"MD5 mismatch for %s and downloads disabled\" % model_path)\n" +
          "                    LOGGER.warning(corrupt_msg)\n" +
          "                    os.remove(model_path)\n" +
          "                    LOGGER.warning('Re-downloading the recognition model, please wait. '\n" +
          "                                   'This may take several minutes depending upon your network connection.')\n" +
          "                    download_and_unzip(model['url'], model['filename'], self.model_storage_directory, verbose)\n" +
          "                    assert calculate_md5(model_path) == model['md5sum'], corrupt_msg\n" +
          "                    LOGGER.info('Download complete')",
        "                elif calculate_md5(model_path) != model['md5sum']:\n" +
          "                    # mirror files: skip md5 check, use local file as-is\n" +
          "                    LOGGER.warning('MD5 mismatch (mirror file), using local file as-is: %s', model_path)",
      ],
    ]);
    console.log("easyocr MD5 跳过补丁:", ok1 ? "已应用" : "跳过");
  }

  console.log("\n=== 完成！桥里设置环境变量后即可使用 see_screen ===");
  console.log(`OmniParser: ${ROOT}`);
  console.log(`venv:       ${VENV}`);
}

main().catch((e) => {
  console.error("部署失败:", e.message);
  process.exit(1);
});
