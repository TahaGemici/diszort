# Diszort

Arkadaş grupları için tarayıcıdan girilen, Discord benzeri küçük bir sohbet sunucusu. Yazılı kanallar
sunucuda saklanır; sesli kanallarda ses kişiler arasında doğrudan (P2P) akar, doğrudan bağlanamayanlar
için sunucudaki TURN aktarır. İçeri yalnızca içeridekilerin onayıyla girilir.

## Özellikler

- **Beyaz liste:** Yeni gelen adını yazar; içeridekilerden biri onaylarsa tarayıcısına kişisel bir
  anahtar kaydedilir ve sonraki girişlerde soru sorulmaz. İçeridekiler birbirini atabilir.
- **Yazılı kanallar:** mesaj geçmişi, dosya paylaşımı (resim/ses/video önizlemeli), bahsetme,
  tıklanabilir bağlantılar, resim büyüteci.
- **Sesli kanallar:** kanal başına 10 kişiye kadar, yüksek kaliteli Opus (~96 kbps), konuşma göstergesi,
  kişi başı ses seviyesi, susturma ve sağırlaştırma, mikrofon/hoparlör seçimi, gürültü bastırma.
- **Kopmalara dayanıklı:** sunucu bağlantısı koparsa ya da telefon siteyi arka plana alırsa ses sürer,
  bağlantı kendiliğinden geri gelir.
- Kanallar arayüzden eklenip silinir; masaüstünde ve telefonda çalışır.

## Kurulum

Gerekenler: Docker (compose eklentisiyle) ve HTTPS için bir alan adı.

```sh
curl -fsSL https://github.com/TahaGemici/diszort/releases/latest/download/kur.sh | sudo sh
```

Betik imajı `ghcr.io/tahagemici/diszort`'tan çeker, ayarları ve veritabanını `/var/lib/chat` altında
oluşturur ve `diszort` konteynerini başlatır. Güncellemek için aynı komut çalıştırılır; belirli bir
sürüme dönmek için sonuna `-s v23` gibi bir sürüm eklenir.

**Açık olması gereken portlar:** TCP 80 ve 443 (HTTPS), UDP ve TCP 3478 (STUN/TURN), UDP 49152–61000
(TURN aktarımı).

**HTTPS:** Mikrofon yalnızca HTTPS'te çalışır. Caddy ile örnek: [`kurulum/Caddyfile`](kurulum/Caddyfile)
(`/etc/caddy/Caddyfile`, alan adı → `127.0.0.1:8080`). TURN Caddy'den geçmez.

**İlk giriş:** Beyaz liste boşken sunucu ilk anahtarı üretir ve giriş bağlantısıyla birlikte
`/var/lib/chat/ilk-anahtar.txt` dosyasına yazar. Bağlantı bir kez açılınca anahtar tarayıcıya kaydedilir;
dosya sonra silinebilir.

## Ayarlar

`/var/lib/chat/.env` dosyasında; değişiklikten sonra `sudo docker restart diszort`. Hepsi isteğe bağlıdır.

| Ayar | Varsayılan | Anlamı |
|---|---|---|
| `MAX_KULLANICI` | 10 | beyaz listedeki en fazla kişi (arayüzden de değiştirilebilir) |
| `MAX_KISI` | 10 | sesli kanal başına en fazla kişi |
| `DOSYA_MB` | 25 | paylaşılabilecek en büyük dosya |
| `YONETICI_ADI` | taha | ilk anahtarın sahibi |
| `SITE_ADRESI` | | ilk anahtar bağlantısındaki site adresi |
| `GIRIS_ARALIK_MS`, `GIRIS_KOVA` | 10000, 1 | giriş freni: sunucu genelinde 10 saniyede 1 deneme |
| `SES_ASKI_MS` | 60000 | bağlantısı kopanın sesli kanaldaki yeri bu kadar korunur |
| `DIS_IP`, `TURN_ADRESI` | kendiliğinden | TURN'ün duyurduğu adres |
| `TANI` | 1 | ses teşhis satırlarını günlüğe yaz (0: kapalı) |

Tam liste ve açıklamalar: [`.env.example`](.env.example).

## Yönetim

| İş | Komut |
|---|---|
| Günlük | `sudo docker logs -f diszort` |
| Yeniden başlatma | `sudo docker restart diszort` |
| Sağlık | `curl http://127.0.0.1:8080/saglik` |
| Yedek | `/var/lib/chat` (ayarlar, `sohbet.db*`, `yuklemeler/`) |

## Geliştirme

```sh
make            # node ile çalıştır (node, npm ve coturn gerekir) → http://127.0.0.1:8080
make docker     # ya da Docker ile
make test       # sunucu denemeleri (çalışan sunucuya karşı, ILK_ANAHTAR ile)
make arayuz     # arayüz denemeleri (jsdom)
make tarayici   # gerçek Chromium'la sesli kanal denemeleri (Playwright)
```

`main`'e her gönderimde GitHub Actions imajı derler, üç deneme takımını imaja karşı çalıştırır,
`ghcr.io`'ya yükler ve sürüm çıkarır.

Yapı: `sunucu/` (Node: web, sohbet, signaling, coturn yönetimi, SQLite), `web/` (düz HTML/CSS/JS),
`kurulum/` (kurulum betiği, Caddy örneği), `test/`. WebSocket protokolü `sunucu/sunucu.js` içinde
açıklanmıştır.

## Güvenlik

- Depoda gizli bilgi yoktur. Beyaz liste anahtarları yalnızca sunucudaki veritabanında ve kişinin
  tarayıcısında durur. TURN sırrı her açılışta yeniden üretilir ve konteynerin dışına yazılmaz.
- `ILK_ANAHTAR` yalnızca testler içindir, üretimde boş kalmalıdır. CI'daki anahtar herkesin bildiği bir
  test değeridir.
- Ses hiçbir yere kaydedilmez; yalnızca yazılı mesajlar ve paylaşılan dosyalar saklanır.

## Sınırlar

- Ses mesh ile taşınır: herkes kanaldaki herkese ayrı ses gönderir, bu yüzden kanal başına ~10 kişi.
  Daha kalabalık odalar için SFU gerekir.
- TURN'den geçen ses sunucunun bant genişliğini kullanır (kişi başı ~100 kbps). Yalnızca IPv4.
