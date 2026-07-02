"""
Qwen3-TTS Worker for Remcli

Loads model once, accepts JSON requests via stdin, outputs OGG audio files.
Communication protocol: JSON lines on stdin/stdout.
Matches usage patterns from /Users/solidhard1/Projects/qwen3-tts reference repo.

Request:  {"id": "abc", "text": "...", "lang": "ru", "output": "/tmp/tts-xxx.ogg", "ref_audio": "...", "ref_text": "..."}
Response: {"id": "abc", "ok": true, "path": "/tmp/tts-xxx.ogg"} or {"id": "abc", "ok": false, "error": "..."}
"""

import os
os.environ["TRANSFORMERS_NO_ADVISORY_WARNINGS"] = "1"
os.environ["TRANSFORMERS_VERBOSITY"] = "error"

import sys
import json
import numpy as np
import soundfile as sf
from mlx_audio.tts.utils import load_model

MODEL_ID = "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit"

# Generation defaults — match model defaults explicitly
# mlx_audio.server has DIFFERENT defaults that cause artifacts (max_tokens=1200, repetition_penalty=1.0)
GENERATION_DEFAULTS = {
    "temperature": 0.9,
    "top_p": 1.0,
    "top_k": 50,
    "repetition_penalty": 1.05,
    "max_tokens": 8192,  # ~30 sec audio (12Hz × 16 codes × 30s = 5760 + overhead)
}


def main():
    # Load model (downloads on first run via huggingface_hub, ~1.7GB)
    model = load_model(MODEL_ID)

    # Signal readiness
    print(json.dumps({"ready": True}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            req_id = req.get("id")
            text = req["text"]
            output_path = req["output"]
            lang = req.get("lang", "ru")
            ref_audio = req.get("ref_audio")
            ref_text = req.get("ref_text")

            generate_kwargs = dict(
                text=text,
                lang_code=lang,
                verbose=False,
                **GENERATION_DEFAULTS,
            )
            if ref_audio and ref_text:
                generate_kwargs["ref_audio"] = ref_audio
                generate_kwargs["ref_text"] = ref_text

            results = list(model.generate(**generate_kwargs))
            if not results:
                print(json.dumps({"id": req_id, "ok": False, "error": "No audio generated"}), flush=True)
                continue

            last_result = results[-1]
            sr = last_result.sample_rate or model.sample_rate

            # Convert MLX array to numpy (matches reference repo pattern exactly)
            # MLX arrays need np.array() for forced copy/conversion; regular arrays use np.asarray()
            audio = last_result.audio
            audio_np = np.array(audio) if hasattr(audio, '__mlx_array__') or type(audio).__name__ == 'array' else np.asarray(audio)
            if audio_np.ndim > 1:
                audio_np = audio_np.squeeze()

            sf.write(output_path, audio_np, sr, format="OGG", subtype="VORBIS")

            print(json.dumps({"id": req_id, "ok": True, "path": output_path}), flush=True)
        except Exception as e:
            print(json.dumps({"id": req_id, "ok": False, "error": str(e)}), flush=True)


if __name__ == "__main__":
    main()
