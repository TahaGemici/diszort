# Diszort — derleme
#   make           kendi bilgisayarında node ile çalıştırır (node, npm ve coturn gerekir) -> http://127.0.0.1:8080
#   make test      çalışan sunucuyu dener (ADRES=http://... ile başka bir adres)
#   make arayuz    arayüzü tarayıcısız dener (jsdom; DOM, kanal seçimi, sesli kanal satırları)
#   make yanki     paylaşılan sesten kanaldakilerin sesini çıkarmayı benzetimle dener (bağımlılık yok)
#   make tarayici  gerçek Chromium'la sesli kanalı dener (Playwright; kendi sunucusunu açar, coturn gerekir)
#   make kayip     paket kaybında RED'in (yedekli ses) etkisini gerçek Chromium'la ölçer (sunucusuz)
#   make docker    Docker imajını derleyip çalıştırır -> http://127.0.0.1:8080
#   make durdur    Docker konteynerini durdurur
#   make temizle   node_modules ve yerel veri/ çıktısını siler

ADRES ?= http://127.0.0.1:8080

calistir: node_modules
	node sunucu/sunucu.js

node_modules: package.json
	npm install --no-audit --no-fund
	touch node_modules

test:
	node test/dene.js $(ADRES)

arayuz: node_modules
	npm install --no-save --no-audit --no-fund jsdom
	node test/arayuz.js

yanki:
	node test/yanki.js

# Gerçek tarayıcı: CI'da (GitHub Actions) her push'ta çalışır; sunucuda (VPS) çalıştırmak gerekmez.
tarayici: node_modules
	npm install --no-save --no-audit --no-fund playwright
	npx playwright install chromium
	node test/tarayici.js

kayip:
	npm install --no-save --no-audit --no-fund playwright
	npx playwright install chromium
	node test/kayip.js

docker:
	docker compose up --build -d

durdur:
	docker compose down

temizle:
	rm -rf node_modules veri

.PHONY: calistir test arayuz yanki tarayici kayip docker durdur temizle
