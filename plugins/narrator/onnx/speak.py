"""Says a text into a WAV file with the ONNX speech model in a folder, through sherpa-onnx.

    speak.py folder out.wav text [--lang fr] [--speed 1.3] [--speaker 0]

The folder holds one model as sherpa-onnx ships it: the .onnx file, tokens.txt and, as the model
needs them, espeak-ng-data/, voices.bin, lexicons, dict/ and rule .fst files. The model's family
(VITS, Kokoro, Kitten, Matcha) is read from the .onnx file's metadata, so a folder of any name
works. A Matcha model takes its vocoder (a Vocos or HiFi-GAN .onnx) from the same folder. A file named for a
language (lexicon-us-en.txt, number-zh.fst) is only used for that language.
"""
import argparse
import mmap
import sys
from pathlib import Path

import sherpa_onnx

# The vocoders' model types sherpa-onnx takes for a Matcha model (vocoder.cc).
VOCODERS = ("vocos", "matcha-tts vocos", "hifigan")


def varint(data, at):
    value = shift = 0
    while True:
        byte = data[at]
        at += 1
        value |= (byte & 0x7F) << shift
        shift += 7
        if byte < 0x80:
            return value, at


def fields(data, at, end):
    """The protobuf fields between at and end, as (number, (start, end)) for length-delimited ones."""
    while at < end:
        key, at = varint(data, at)
        kind = key & 7
        if kind == 0:
            _, at = varint(data, at)
            yield key >> 3, None
        elif kind == 1:
            at += 8
        elif kind == 2:
            size, at = varint(data, at)
            yield key >> 3, (at, at + size)
            at += size
        elif kind == 5:
            at += 4
        else:
            raise ValueError(f"not an ONNX file (wire type {kind})")


def metadata(path):
    """An .onnx file's metadata_props (ModelProto field 14), read without loading the model."""
    found = {}
    with open(path, "rb") as file, mmap.mmap(file.fileno(), 0, access=mmap.ACCESS_READ) as data:
        for number, span in fields(data, 0, len(data)):
            if number == 14:
                entry = {n: bytes(data[s:e]).decode() for n, (s, e) in fields(data, *span) if n in (1, 2)}
                found[entry.get(1)] = entry.get(2, "")
    return found


def for_language(paths, lang, region=""):
    """The files for every language, and those named for this one (lexicon-us-en.txt is for en).
    Of several for this language, those of the model's own region (us, of its voice en-us) only."""
    shared, own = [], []
    for path in sorted(paths):
        tag = path.stem.rsplit("-", 1)[-1] if "-" in path.stem else ""
        if len(tag) in (2, 3) and tag.isalpha():
            if tag == lang:
                own.append(path)
        else:
            shared.append(path)
    regional = [path for path in own if region and f"-{region}-" in f"-{path.stem}-"]
    return ",".join(str(path) for path in shared + (regional or own))


def config(folder, lang):
    models, voice = {}, ""
    for path in folder.glob("*.onnx"):
        found = metadata(path)
        models.setdefault(found.get("model_type", ""), path)
        if found.get("model_type") not in VOCODERS:
            voice = voice or found.get("voice", "")
    region = voice.lower().split("-", 1)[1] if voice.lower().startswith(f"{lang}-") else ""
    tokens = str(folder / "tokens.txt")
    espeak = folder / "espeak-ng-data"
    data_dir = str(espeak) if espeak.is_dir() else ""
    dict_dir = str(folder / "dict") if (folder / "dict").is_dir() else ""
    lexicon = for_language(folder.glob("lexicon*.txt"), lang, region)
    voices = str(folder / "voices.bin")

    model = sherpa_onnx.OfflineTtsModelConfig(num_threads=2)
    if "vits" in models:
        model.vits = sherpa_onnx.OfflineTtsVitsModelConfig(
            model=str(models["vits"]), tokens=tokens, lexicon=lexicon, data_dir=data_dir, dict_dir=dict_dir)
    elif "kokoro" in models:
        model.kokoro = sherpa_onnx.OfflineTtsKokoroModelConfig(
            model=str(models["kokoro"]), voices=voices, tokens=tokens, lexicon=lexicon,
            data_dir=data_dir, lang=lang)
    elif "kitten-tts" in models:
        model.kitten = sherpa_onnx.OfflineTtsKittenModelConfig(
            model=str(models["kitten-tts"]), voices=voices, tokens=tokens, data_dir=data_dir)
    elif "matcha-tts" in models:
        vocoder = next((models[kind] for kind in VOCODERS if kind in models), None)
        if vocoder is None:
            sys.exit(f"speak.py: the Matcha model in {folder} needs its vocoder (a Vocos or HiFi-GAN .onnx) beside it")
        model.matcha = sherpa_onnx.OfflineTtsMatchaModelConfig(
            acoustic_model=str(models["matcha-tts"]), vocoder=str(vocoder), tokens=tokens,
            lexicon=lexicon, data_dir=data_dir, dict_dir=dict_dir)
    else:
        found = ", ".join(sorted(filter(None, models))) or "none"
        sys.exit(f"speak.py: no model sherpa-onnx speaks with in {folder} (model types found: {found})")

    return sherpa_onnx.OfflineTtsConfig(model=model, rule_fsts=for_language(folder.glob("*.fst"), lang))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("folder", type=Path)
    parser.add_argument("out")
    parser.add_argument("text")
    parser.add_argument("--lang", default="")
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--speaker", type=int, default=0)
    args = parser.parse_args()

    tts_config = config(args.folder.expanduser(), args.lang.lower())
    if not tts_config.validate():
        sys.exit(f"speak.py: sherpa-onnx cannot use the files in {args.folder}")
    generation = sherpa_onnx.GenerationConfig()
    generation.sid = args.speaker
    generation.speed = args.speed
    audio = sherpa_onnx.OfflineTts(tts_config).generate(args.text, generation)
    if not audio.samples:
        sys.exit("speak.py: the model said nothing")
    sherpa_onnx.write_wave(args.out, audio.samples, audio.sample_rate)


if __name__ == "__main__":
    main()
