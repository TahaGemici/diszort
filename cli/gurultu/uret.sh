#!/bin/sh
# web/rnnoise.wasm'ı (web istemcisinin kullandığı RNNoise'un kendisi) C'ye çevirir: CLI aynı modeli
# yerel hızla çalıştırır. wasm2c (wabt) gerekir: sudo apt install wabt. Çıktılar depoya girmez.
set -e
cd "$(dirname "$0")"
wasm2c ../../web/rnnoise.wasm -n rnnoise -o rnnoise_w2c.c
KOK=$(dirname "$(command -v wasm2c)")/..
for d in "$KOK/share/wabt/wasm2c" /usr/share/wabt/wasm2c /usr/src/wasm2c; do
	[ -f "$d/wasm-rt-impl.c" ] && { cp "$d/wasm-rt-impl.c" wasm_rt_impl.c; cp "$d/wasm-rt-impl.h" .; break; }
done
for b in wasm-rt.h wasm-rt-exceptions.h; do
	for d in "$KOK/include" /usr/include /usr/src/wasm2c "$KOK/share/wabt/wasm2c"; do
		[ -f "$d/$b" ] && { cp "$d/$b" .; break; }
	done
done
[ -f wasm_rt_impl.c ] && [ -f wasm-rt.h ] || { echo "wasm2c çalışma kitaplığı bulunamadı" >&2; exit 1; }
