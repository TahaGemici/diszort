// Web Worker'ın karşılığı: sayfanın işçi dosyası (web/yanki.js: yankı tahmini) ayrı bir iş
// parçacığında, tarayıcıdaki gibi kendi kapsamında (self, postMessage, onmessage) çalışır.
'use strict';

const { Worker: Parcacik } = require('node:worker_threads');
const { olayOzellikleri } = require('./ses/webaudio');

// İş parçacığında çalışan başlatıcı: işçi kapsamını kurar, dosyayı orada çalıştırır.
const BASLATICI = `
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
class WorkerGlobalScope {}
const kure = new WorkerGlobalScope();
Object.assign(kure, {
	self: kure,
	WorkerGlobalScope,
	console,
	setTimeout,
	clearTimeout,
	setInterval,
	clearInterval,
	performance,
	postMessage: (veri, aktar) => parentPort.postMessage(veri, Array.isArray(aktar) ? aktar : undefined),
	close: () => process.exit(0),
});
vm.createContext(kure, { name: 'Worker' });
parentPort.on('message', (veri) => {
	if (typeof kure.onmessage === 'function') kure.onmessage.call(kure, { data: veri });
});
vm.runInContext(workerData.kaynak, kure, { filename: workerData.ad });
`;

// kaynakOku(adres) → Promise<metin>: işçi dosyasını verir.
function isciSinifi(kaynakOku, kayit) {
	class Worker extends EventTarget {
		constructor(adres) {
			super();
			this.parcacik = null;
			this.bekleyen = []; // dosya yüklenene kadar gönderilen iletiler
			this.bitti = false;
			kayit.add(this);
			Promise.resolve()
				.then(() => kaynakOku(String(adres)))
				.then((kaynak) => {
					if (this.bitti) return;
					const p = new Parcacik(BASLATICI, { eval: true, workerData: { kaynak: String(kaynak), ad: String(adres) } });
					this.parcacik = p;
					p.unref();
					p.on('message', (veri) => this.dispatchEvent(Object.assign(new Event('message'), { data: veri })));
					p.on('error', (h) => this.dispatchEvent(Object.assign(new Event('error'), { message: String((h && h.message) || h), error: h })));
					for (const [veri, aktar] of this.bekleyen.splice(0)) p.postMessage(veri, aktar);
				})
				.catch((h) => this.dispatchEvent(Object.assign(new Event('error'), { message: String((h && h.message) || h), error: h })));
		}
		postMessage(veri, aktar) {
			if (this.bitti) return;
			const liste = Array.isArray(aktar) ? aktar : aktar && Array.isArray(aktar.transfer) ? aktar.transfer : undefined;
			if (this.parcacik) this.parcacik.postMessage(veri, liste);
			else this.bekleyen.push([veri, liste]);
		}
		terminate() {
			if (this.bitti) return;
			this.bitti = true;
			kayit.delete(this);
			this.bekleyen = [];
			if (this.parcacik) this.parcacik.terminate().catch(() => {});
		}
	}
	olayOzellikleri(Worker, 'message', 'error', 'messageerror');
	return Worker;
}

module.exports = { isciSinifi };
