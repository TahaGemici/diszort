#!/bin/sh
# Terminal istemcisini tek dosya olarak derler: cikti/diszort-linux-x64 ve cikti/surum.json (özet).
# Gerekenler: Go, gcc ve C kitaplıklarının geliştirme paketleri (programa gömülürler):
#   sudo apt install golang gcc libopus-dev libvpx-dev libyuv-dev libspeexdsp-dev libpipewire-0.3-dev wabt
# Ortam değişkenleri: SURUM (vYY.AA.GG), COMMIT, DEPO (güncelleme için), CIKTI (klasör).
set -e
KOK=$(cd "$(dirname "$0")/.." && pwd)
SURUM=${SURUM:-yerel}
COMMIT=${COMMIT:-$(git -C "$KOK" rev-parse --short=7 HEAD 2>/dev/null || true)}
DEPO=${DEPO:-TahaGemici/diszort}
CIKTI=${CIKTI:-$KOK/cikti}
sh "$KOK/cli/gurultu/uret.sh"
mkdir -p "$CIKTI"
cd "$KOK/cli"
CGO_ENABLED=1 go build -trimpath -ldflags "-s -w -X main.surum=$SURUM -X main.commit=$COMMIT -X main.depo=$DEPO" -o "$CIKTI/diszort-linux-x64" .
OZET=$(sha256sum "$CIKTI/diszort-linux-x64" | cut -d' ' -f1)
printf '{\n\t"surum": "%s",\n\t"commit": "%s",\n\t"sha256": {\n\t\t"diszort-linux-x64": "%s"\n\t}\n}\n' "$SURUM" "$COMMIT" "$OZET" > "$CIKTI/surum.json"
echo "$CIKTI/diszort-linux-x64: $(du -h "$CIKTI/diszort-linux-x64" | cut -f1) ($SURUM, $COMMIT)"
