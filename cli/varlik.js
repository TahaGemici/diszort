// İstemcinin dosyaları (web/: index.html, ana.js, gurultu.js, yanki.js, rnnoise.wasm) ve yapı bilgisi.
//
// Tek dosyalık programda bunlar programın içine gömülüdür (derle.js); geliştirirken depodaki web/
// klasöründen okunur. İstenirse (ayar: "istemciKodu": "sunucu") tarayıcı gibi sunucudan alınır.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const gomulu = (() => {
	try {
		const sea = require('node:sea');
		return sea.isSea() ? sea : null;
	} catch {
		return null;
	}
})();

const AD_KALIBI = /^[a-z0-9][a-z0-9._-]*$/i;
function adDenetle(ad) {
	ad = String(ad).replace(/^\.?\//, '').split(/[?#]/)[0];
	if (!AD_KALIBI.test(ad)) throw Object.assign(new Error('Geçersiz dosya adı: ' + ad), { name: 'NotFoundError' });
	return ad;
}

// Yapı bilgisi: { surum, depo } (depo: güncellemelerin alındığı GitHub deposu, "sahip/ad").
function yapiBilgisi() {
	if (gomulu) {
		try {
			return JSON.parse(gomulu.getAsset('yapi.json', 'utf8'));
		} catch {}
	}
	return { surum: 'yerel', depo: '' };
}

// Programla gelen dosyalar.
function gomuluVarliklar(klasor = path.join(__dirname, '..', 'web')) {
	return {
		kaynak: gomulu ? 'program' : klasor,
		async oku(ad) {
			ad = adDenetle(ad);
			if (gomulu) return Buffer.from(gomulu.getRawAsset('web/' + ad));
			return fs.promises.readFile(path.join(klasor, ad));
		},
	};
}

// Sunucunun gönderdiği dosyalar (tarayıcının yaptığı gibi).
function sunucuVarliklari(adres) {
	return {
		kaynak: adres,
		async oku(ad) {
			ad = adDenetle(ad);
			const yanit = await fetch(new URL('/' + ad, adres), { redirect: 'error' });
			if (!yanit.ok) throw Object.assign(new Error(`${ad}: HTTP ${yanit.status}`), { name: 'NotFoundError' });
			return Buffer.from(await yanit.arrayBuffer());
		},
	};
}

module.exports = { gomulu: !!gomulu, yapiBilgisi, gomuluVarliklar, sunucuVarliklari };
