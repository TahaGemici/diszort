// WebRTC kitaplığının yerel (C++) parçası: tek dosyalık programda programa gömülü kopyadan.
//
// Yerel kitaplık ancak diskteki bir dosyadan yüklenebilir: gömülü kopya (sıkıştırılmış) açılıp geçici
// bir dosyaya yazılır, yüklenir ve hemen silinir (yüklenen kitaplık bellekte kalır; diskte bir şey
// kalmaz). Geçici dosya önce /dev/shm'ye (bellekte, diske yazılmaz), olmazsa geçici klasöre.
// Geliştirirken (node cli/diszort.js) paketin kendisi yüklenir.
'use strict';

const sea = (() => {
	try {
		const s = require('node:sea');
		return s.isSea() ? s : null;
	} catch {
		return null;
	}
})();

function gomuluYukle() {
	const fs = require('node:fs');
	const os = require('node:os');
	const path = require('node:path');
	const zlib = require('node:zlib');
	const veri = zlib.gunzipSync(Buffer.from(sea.getRawAsset('wrtc.node.gz')));
	const adlar = [];
	for (const klasor of ['/dev/shm', os.tmpdir()]) adlar.push(path.join(klasor, `diszort-${process.pid}-${Date.now()}.node`));
	let sonHata = null;
	for (const yol of adlar) {
		try {
			fs.writeFileSync(yol, veri, { mode: 0o700 });
		} catch (h) {
			sonHata = h;
			continue;
		}
		const m = { exports: {} };
		try {
			process.dlopen(m, yol);
			return m.exports;
		} catch (h) {
			// /dev/shm "noexec" bağlanmış olabilir: sıradaki yer denenir.
			sonHata = h;
		} finally {
			try {
				fs.unlinkSync(yol);
			} catch {}
		}
	}
	throw new Error('WebRTC kitaplığı yüklenemedi: ' + ((sonHata && sonHata.message) || sonHata));
}

module.exports = sea ? gomuluYukle() : require(`@roamhq/wrtc-${process.platform}-${process.arch}`);
