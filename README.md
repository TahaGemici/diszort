# Diszort

Arkadaş grupları için tarayıcıdan girilen, Discord benzeri küçük bir sohbet sunucusu. Yazılı kanallar
sunucuda saklanır; sesli kanallarda ses ve ekran paylaşımı (ekranlı ya da ekransız, yalnızca ses)
kişiler arasında doğrudan (P2P) akar, doğrudan bağlanamayanlar için sunucudaki TURN aktarır. Dosyalar
da sunucuya yüklenmez, paylaşandan doğrudan alınır. İçeri yalnızca içeridekilerin onayıyla girilir.

## Özellikler

- **Beyaz liste:** Yeni gelen adını yazar; içeridekilerden biri onaylarsa tarayıcısına kişisel bir
  anahtar kaydedilir ve sonraki girişlerde soru sorulmaz. İçeridekiler birbirini atabilir.
- **Yazılı kanallar:** mesaj geçmişi, bahsetme, tıklanabilir bağlantılar, resim büyüteci.
- **P2P dosya paylaşımı, boyut sınırı yok:** dosya sunucuya yüklenmez; sohbete yalnızca adı ve boyutu
  düşer, isteyen doğrudan paylaşanın tarayıcısından alır. Paylaşan sayfayı açık tuttukça indirilebilir
  (sayfayı yenilerse "Yeniden paylaş" ile aynı dosyayı yeniden sunar). Kopan aktarım kaldığı yerden
  sürer; büyük dosyalar belleğe değil doğrudan diske yazılır. Küçük resimler sohbette önizlenir.
- **Sesli kanallar:** kanal başına 10 kişiye kadar, yüksek kaliteli Opus (~96 kbps), konuşma göstergesi,
  kişi başı ses seviyesi, susturma ve sağırlaştırma, mikrofon/hoparlör seçimi.
- **Mikrofonun yolu: RNNoise ve konuşma eşiği.** Mikrofon her zaman RNNoise'dan geçer (Xiph/Mozilla'nın
  yapay sinir ağıyla gürültü bastırıcısı, Jitsi'nin WebAssembly derlemesi: `web/rnnoise.wasm`, lisanslar
  `web/rnnoise.LICENSE.txt`; `web/gurultu.js`, AudioWorklet). Hep açık, kapatılamaz; ses ayarları
  kullanıldığını ve o anki sonucunu (konuşma olasılığı, bastırılan gürültü) yazar. Tarayıcının kendi
  gürültü bastırması bu yüzden kapalı istenir (iki kez bastırmak sesi bozar); RNNoise kurulamazsa
  (AudioWorklet/WebAssembly yok, dosya gelmedi) tarayıcınınki açılır. Ölçüm (yalnız gürültü, 6 sn):
  fan uğultusu −40…−50 dB, 4 kHz altı tıslama −58 dB, 50 Hz vızıltı −12 dB, geniş bantlı tıslama
  −10…−13 dB, tam bant beyaz gürültü yalnızca ~−2 dB (RNNoise'un zayıf yeri); konuşmaya dokunmuyor.
  Gerçek Chromium ve Firefox'ta fanlı konuşmada: konuşma −28 dBFS'te aynen, aralardaki fan −49'dan
  −68 dBFS'e. İşlemci: tek çekirdeğin ~%2'si; gecikme 10 ms. RNNoise 48 kHz için eğitildi; ses bağlamı
  44,1 kHz'de çalışan sistemlerde de çalışıyor, bastırması biraz daha az. Ardından mikrofon seviyesi ve
  **konuşma eşiği** (Discord'daki giriş hassasiyeti; %0 kapalı, varsayılan %10 = −55 dBFS, ayarlardaki
  seviye çubuğuyla aynı ölçek, çubukta çizgi olarak görünür): ses eşiğin altındayken gönderilmez; eşiği
  geçince hemen açılır, altında 300 ms kalınca kapanır (kelime sonları kesilmez). Konuşurken de
  değiştirilebilir. Otomatik kazanç (AGC) yok (hep kapalı istenir). **Yankı engelleme** aç/kapa,
  varsayılan kapalı (çıkış aygıtından bağımsız; eski sürümlerin "açık" kaydı taşınmaz): hoparlörle
  konuşan açar, yoksa kanaldakiler kendi seslerini geri duyar. RNNoise yankıyı silmez: yankı da konuşma.
  Bilgisayar sesi (paylaşım) bu yoldan geçmez.
- **Susturunca mikrofon tamamen kapanır** (her cihazda; sağırlaştırınca da): tarayıcının kayıt
  göstergesi söner. Telefonda açık mikrofon telefonu görüşme kipinde tutar (Bluetooth kulaklık tek
  kanallı, boğuk görüşme sesine geçer; çalan ses telefonun görüşme işlemlerinden geçer): susturulmuş
  dinleyende paylaşılan müzik tam kalitede çalar. Açınca mikrofon bir anda yeniden alınır.
- **Telefonda:** sesli kanaldayken ekran kendiliğinden kapanmaz. Android'de sayfa arka planda ve ekran
  kilitliyken de çalışır: sesli kanaldayken döngüde sessiz bir ses çalınır, tarayıcı bildirimde bir
  oynatıcı gösterir (Android, oynatmayan ya da kayıt yapmayan uygulamayı arka planda dondurur).
  Bildirimdeki duraklat bir şey yapmaz; başka bir uygulama sesi alırsa (müzik, arama) o sesin üstüne
  çıkılmaz. Paket gelip ses çalınmıyorsa (arka plandan dönünce görülen) ses kendiliğinden yeniden bağlanır.
  Kulaklıkla konuşurken çalan ses görüşme kalitesine düşmez: Chrome (Samsung Internet vb. de) Android'de
  yankı engellemeli bir mikrofon açılınca telefonu görüşme kipine alır, Bluetooth kulaklık tek kanallı
  görüşme profiline geçer; yankı engellemesi kapalı mikrofonda almaz (Chromium kaynağı). Kulaklık
  takılıyken yankı engelleme (açılmışsa da) kapalı istenir (kulaklıkta yankı olmaz); Bluetooth kulaklıkta ses
  telefonun kendi mikrofonundan alınır (kulaklığın mikrofonu onu yine görüşme profiline geçirirdi),
  telefon konuşana yakın olmalı. Konuşurken kulaklık takılıp çıkarılırsa (Bluetooth bağlanıp
  koparsa) mikrofon yeni duruma göre yeniden açılır (kulaklık çıkınca ses hoparlörden çalar: yankı
  engelleme ayardaki gibi, varsayılan kapalı). Ses ayarlarında mikrofon seçildiyse ona dokunulmaz. Klasik Bluetooth kulaklık
  zaten aynı anda hem stereo müzik çalıp hem mikrofonunu kullanamaz (her uygulamada mikrofon devreye
  girince görüşme sesine düşer); telefonun mikrofonunu kullanmak bunun bilinen çözümüdür. Görüşme
  kipinde Android başka uygulamalarınki de dahil bütün sesleri görüşme yoluna verir, A2DP'yi hiç
  kullanmaz (Android ses politikası: frameworks/av, enginedefault/src/Engine.cpp). Bu yol konuşma
  için yapılmıştır (tek kanal, 8 kHz'e kadar): konuşmada bozulma pek fark edilmez, müzikte barizdir.
  Ses bağlamının gecikmesi de bunu gösterir: A2DP'de ~250 ms, görüşme kipinde ~100 ms.
- **Kayıplara karşı yedek (RED):** ses paketi (konuşma da paylaşılan ses de) bir öncekinin kopyasını da
  taşır; tek tük kaybolan paket bir sonrakinden yerine konur. Ses ayarlarında kalite seçiminin yanındaki
  RED kutusuyla mikrofon ve paylaşım için ayrı ayrı açılıp kapanır (varsayılan açık); her gönderen kendi
  sesine karar verir (tarayıcı RED'i karşının açıklamasında Opus'tan önce geliyorsa kullanır: sayfa
  karşının açıklamasını uygularken sırayı kendi seçimine göre dizer). Alıcının uydurmak zorunda kaldığı
  ses %10 rastgele kayıpta konuşmada ~%6'dan ~%0,4-1'e, müzikte ~%6'dan ~%0,3-0,8'e iner; bedeli bit
  hızının iki katı. Kayıplar art arda gelince (ortalama 3 paketlik patlamalar, gerçek ağa daha yakın)
  kazanç az: konuşmada %27-54, müzikte %5-12 (test/kayip.js), çünkü tarayıcının RED'i yalnızca bir
  önceki çerçeveyi taşır (libwebrtc kRedNumberOfRedundantEncodings = 1; daha derini ya da aralıklısı
  tarayıcının deneme bayrağı ister, sayfa değiştiremez). RED'i bilmeyen tarayıcıyla (Firefox: ne
  gönderir ne alır; kutu kapalı görünür) o bağlantı iki yönde de düz Opus'tur.
- **Ekran paylaşımı ve birlikte dinleme** (ses kartındaki paylaş düğmesi):
  - *Bilgisayar sesi işlenmez:* tarayıcının yankı engellemesi, gürültü bastırması ve otomatik kazancı
    kapalı istenir; RNNoise ve konuşma eşiği uygulanmaz. Tek işlem, bilgisayarın sesine karışan
    kanaldakilerin konuşmasının (sayfanın kendi çaldığı) çıkarılmasıdır: o olmasa herkes kendi sesini
    geri duyardı; kimse konuşmuyorken ses olduğu gibi gider, müzik değişmez (gerçek Chromium denemesi).
    Kanallar: stereo (varsayılan) ya da mono. Gönderilen veri kanal sayısıyla değil bit hızıyla (kbps)
    belirlenir. İki kanal aynıysa (mono içerik) Opus stereo'da kanalların farkına neredeyse bit harcamaz:
    aynı kbps'de stereo ≈ mono. Tarayıcıda mono müzik için daha kötü: libwebrtc tek kanalı ses kipinde
    (OPUS_APPLICATION_VOIP) kodluyor, bu kip 60-100 Hz altını kesen bir süzgeç ekliyor. Ölçüm (gerçek
    müzik, sinyalin aslıyla farkına oranı): ses kipinde mono 160 kbps 1,9 dB (süzgecin faz kayması da
    sayılır), 20-60 Hz −4 dB; müzik kipinde mono 160 26,9 dB, aynı kanallı stereo 160'ta 26,2, 320'de
    27,8 dB, bas değişmiyor. Mono yalnızca konuşma için anlamlı.
  - *Kalite* (ses ve paylaşım ayarları). Paylaşılan ses (bilgisayarın sesi; stereo Opus, mikrofon ayrı
    kanalda, tek kanal): 320 / 256 / 192 (varsayılan) / 128 / 96 kbps, yanında RED kutusu. Tarayıcılar
    sesi sıkıştırmadan gönderemez (Firefox'ta Opus'tan başka müzik kodeği yok); kodlayıcıya giden ses
    her tarayıcıda 16 bit. En yükseği 320: Spotify'ın en yüksek kayıplı kalitesi ("Çok yüksek", Ogg Vorbis
    320 kbps; Opus aynı hızda daha verimli). Opus'un kendi sınırı 510 (tek çerçeve en çok 1275 bayt);
    Spotify'ın kayıpsız (FLAC) kalitesinin tarayıcıda karşılığı yok. Yedek aynı pakette gider ve
    tarayıcıda paket 1200 baytı geçemez: gerçek müzikte 192'de sığıyor (%10 rastgele kayıpta uydurulan
    ses %3,1 → %0,4), 256'da çoğu zaman sığmıyor (%3,6 → %1,5), 320'de (çerçeve ~800 bayt) sığmıyor;
    bu yüzden 256 ve 320'de RED kutusu kapalı (üstüne gelince nedenini yazar), seçim saklanır. 192 de
    aslından ayırt edilmez. Yedek yalnızca iki taraf da Chrome tabanlıysa (Chrome, Edge, Samsung
    Internet…) çalışır: Firefox RED'i hiç bilmez (en yenisi 160'ta da yok), o yüzden Firefox'la her
    bağlantı (konuşma da) yedeksizdir. Linux'ta bilgisayarın sesini ancak Firefox paylaşabilir (Chrome
    Linux'ta "Monitor of …" aygıtlarını bilerek gizliyor); Chrome'da sekmenin sesi yedekli gider.
    Ekranın ayarı yok: ekranın kendi çözünürlüğünde, tarayıcıların ekran yakalama sınırı olan 120
    kare/sn'ye kadar yakalanır, bit hızına tavan konmaz; tarayıcı bit hızını, gerekirse çözünürlüğü ve
    kare hızını ağa ve işlemciye göre kendisi ayarlar. Tavan vermemek yetmiyor (Chrome kendi
    varsayılanında, HD'de 2,5 Mbit/s'de kalıyor; ölçüm: tavansız 1,6, 100 Mbit/s tavanla 9,5 Mbit/s):
    pratikte sınırsız bir tavan (100 Mbit/s) verilir. Sunucu üzerinden (TURN) giden bağlantıda en çok 3
    Mbit/s (sunucu aktarım başına ~4 Mbit/s'nin üstünü atar). Firefox kendi sınırlarının üstüne çıkmaz:
    kodlayıcısı 60 kare/sn'yi geçmez (media.navigator.video.max_fr, Firefox'un about:config ayarı),
    ~3,1 megapikselden büyük kareyi küçültür (max_fs: 2048×1536 kadar) ve 1080p'de en çok ~5 Mbit/s
    gönderir (ölçüm: 10 Mbit/s tavanda 5,2; 1920×1200 üstünde 10). Görüntüde ayrıca yedek gerekmez:
    tarayıcılar kayıp paketi yeniden ister (NACK/RTX) ve kayıp görünce düzeltme paketi (ULPFEC) ekler.
    Ses kalitesi ve RED Firefox'ta yalnızca yeniden anlaşmayla değişir: sayfa bunu kendisi yapar
    (yanıtladığı bağlantıda karşıdan yeni teklif ister), konuşma kesilmez.
  - *Ekranını paylaş*: ekran, pencere ya da sekme; istenirse sesiyle. İstemeyen görüntüyü kapatır
    (ona hiç gönderilmez, ses yine gelir).
  - *Ekransız paylaş*: bilgisayarın ya da Spotify/YouTube çalan sekmenin sesini paylaşmak da bir ekran
    paylaşımıdır, yalnızca ekran kimseye gönderilmez: ses kanala stereo ve yüksek kalitede gider.
    Paylaşan ekranı sonradan yeniden seçmeden gösterip gizleyebilir. Firefox ve Safari ekran
    paylaşımında ses vermediği için orada ses bir ses aygıtından alınır: tarayıcının çaldığı hoparlörün
    (ses ayarlarında seçilen ya da sistemin varsayılanı) "Monitor of …" aygıtı sorulmadan seçilir;
    bulunamazsa (Windows'ta "Stereo Karışımı", Mac'te sanal aygıt) sorulur. Kanaldakilerin
    konuşması bu sesten çıkarılır: sayfa ne çaldığını
    bilir, gecikmesini ve seviyesini bulup yakalanan sesten çıkarır (tarayıcının yankı engelleyicisi
    kullanılmaz, müzik eşiksiz ve kesilmeden gider). Paylaşılan aygıt tarayıcının ilk açtığı ses
    girişi olmalı: Firefox sonradan açılan ikinci aygıtı ayrı bir arabellekten geçiriyor (ölçümde
    mikrofon önce açıkken yakalama 0,8-0,9 sn gecikti, dinleyen ~4 sn gecikme ve 1-5 sn'lik boşluklar
    duydu; aygıt önce açılınca 79 ms, sonradan açılan mikrofonla da). Bu yüzden Firefox'ta mikrofon
    açıkken paylaşım başlatılırsa mikrofon bir an (~0,5 sn) bırakılıp geri alınır. Firefox'ta yakalama
    gecikmesi ölçülür (duyulmayacak kadar tiz, kısık bir sesle); 300 ms'yi aşarsa yakalama aynı
    sırayla kendiliğinden yeniden açılır.
  - Paylaşım, kanaldakilerde bir yayın kartı olarak görünür (CANLI): ekranlıysa görüntü, sesliyse ses
    satırı. Herkes paylaşımın sesini kendi için susturur ya da kısar; ses geldikçe kart ışır.
  - İzlemek ve dinlemek her cihazda olur (telefonda görüntüyü kapatıp yalnızca dinlenebilir).
    Paylaşmak tarayıcıya bağlıdır: paylaş düğmesi yalnızca tarayıcı ekran paylaşımı sunuyorsa görünür
    (masaüstü tarayıcılar; iPhone'da yok, Android'de tarayıcıya göre).
- **Bağlantı göstergesi:** yalnızca ses gerçekten bozulunca (alıcının uydurmak zorunda kaldığı ses) uyarır;
  tek kişinin bağlantısı kötüyse yalnızca onun kutusunda görünür.
- **Sunucu penceresi** (sol üstteki veritabanı simgesi): veritabanının boyutu ve mesaj sayısı;
  *Sohbeti temizle* tüm kanallarda ya da tek kanalda, hepsini ya da belli bir süreden eskileri siler.
  Yalnızca yazılı mesajlar silinir; beyaz liste, kanallar ve ayarlar kalır.
- **Kopmalara dayanıklı:** sunucu bağlantısı koparsa ya da telefon siteyi arka plana alırsa ses sürer,
  bağlantı kendiliğinden geri gelir.
- **Gecikme birikmez:** sesi çalan çıkış bir an durursa (telefonda mikrofon açılıp kapanınca Android ses
  kipini değiştirir; çalma ilk başlarken de olabiliyor) gelen ses alıcının tamponunda birikir;
  tarayıcı bunu ancak sesi hızlandırarak eritir (2 sn'lik duruş gerçek müzikte de konuşmada da
  ~10 sn sürdü, ses bu sürede yer yer %45'e kadar hızlı çaldı; bir telefonda paylaşılan müzikte
  1,4-1,6 sn birikme ölçüldü). Tampon hedefinin 350 ms üstünde ~4 sn kalırsa o kişiyle bağlantı
  kendiliğinden yeniden kurulur (yerel ağda ~30 ms'lik bir kesinti).
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
| `YONETICI_ADI` | taha | ilk anahtarın sahibi |
| `SITE_ADRESI` | | ilk anahtar bağlantısındaki site adresi |
| `GIRIS_ARALIK_MS`, `GIRIS_KOVA` | 10000, 1 | giriş freni: sunucu genelinde 10 saniyede 1 deneme |
| `SES_ASKI_MS` | 60000 | bağlantısı kopanın sesli kanaldaki yeri bu kadar korunur |
| `DIS_IP`, `TURN_ADRESI` | kendiliğinden | TURN'ün duyurduğu adres |
| `TANI` | 1 | ses teşhis satırlarını günlüğe yaz (0: kapalı); bkz. Yönetim |

Tam liste ve açıklamalar: [`.env.example`](.env.example).

## Yönetim

| İş | Komut |
|---|---|
| Günlük | `sudo docker logs -f diszort` |
| Ses teşhisi | `sudo docker logs diszort 2>&1 \| grep -a '\[tanı\]' \| tail -20` |
| Yeniden başlatma | `sudo docker restart diszort` |
| Sağlık | `curl http://127.0.0.1:8080/saglik` (veritabanı boyutu dahil) |
| Yedek | `/var/lib/chat` (ayarlar, `sohbet.db*`) |
| Sohbeti temizle | arayüzde sol üstteki veritabanı simgesi → *Sohbeti temizle* |

Ses teşhisi: sesli kanaldaki her tarayıcı 10 saniyede bir (ve önemli olaylarda) kendi gördüğünü
gönderir, sunucu yalnızca günlüğe yazar (`[tanı] ad: {…}`). Kişi başı: bağlantı durumu ve türü,
konuşmasının ve paylaşımının gelen bit hızı, kaybı, uydurulan sesi, alıcı tamponunun tuttuğu süre
(`tamponMs`, sese eklenen gecikme) ve hedefi, tamponu eritmek/doldurmak için sesten atılan/eklenen
süre (`hizlandirmaMs`/`yavaslatmaMs`, müzikte duyulur), uydurma olayları, titreşim, çalıyor mu;
mikrofonun yolu (`micAyarlar.yol`: RNNoise çalışıyor mu, son ölçüm — konuşma olasılığı, bastırmadan
önce/sonra ve eşikten önceki seviye, eşik açık mı —, eşik, seviye); paylaştığım sesin o kişiye gidişi
(`yayinGiden`: kbps, paket/sn — düzenliyse 50), ekranımın gidişi
(`goruntuGiden`: kbps, çözünürlük, kare/sn, sınırlayan — `cpu`/`bandwidth` —, tavan); seçili paylaşım
kalitesi (`yayinKalite` kbps) ve RED isteği (`redAyar`); sayfa önde mi,
ekran açık mı; mikrofonun ve paylaşılan sesin aygıtı, yakalamadaki kopukluklar (`kopukluk`).
Olaylar: `arka-plan` / `one-geldi` (dönüşten ~6 sn sonra durumun tamamı, `arkaPlanSn`),
`birikme` / `yeniden-kur-istendi`, `calma-takildi`, `durum`, `yeniden-kur`, `teklif-hata`,
`rnnoise-yok` (RNNoise kurulamadı: dosya, modül ya da wasm; tarayıcının gürültü bastırmasına dönüldü). Ses
aygıtından paylaşanda: `yakalama-gecikmesi` (Firefox; sayfa kendi çıkışına duyulmayacak kadar tiz ve kısık,
40 ms'lik bir ses çalar, paylaşılan "Monitor"da kaç ms sonra göründüğünü ölçer: çıkış yolu
`cikisMs` + yakalama yolu; paylaşım başında, 3 dakikada bir ve mikrofon açılıp kapanınca;
`mikrofon`: o an mikrofon açık mı), `yakalama-tazele` (gecikme yüksek ölçüldü: mikrofon bırakılıp
yakalama yeniden açıldı), `yayin-aygit` (`mikOnceBirakildi`: aygıt açılırken mikrofon bir an
bırakıldı) ve `yakalama-kopuklugu` (yakalanan sesteki tam sessizlikler, ms; `*` 200 ms'den uzun;
müzikteki gerçek sessizlikleri de sayar). Sorun sürerken iki cihazın satırlarına birlikte bakılır.

## Geliştirme

```sh
make            # node ile çalıştır (node, npm ve coturn gerekir) → http://127.0.0.1:8080
make docker     # ya da Docker ile
make test       # sunucu denemeleri (çalışan sunucuya karşı, ILK_ANAHTAR ile)
make arayuz     # arayüz denemeleri (jsdom)
make yanki      # paylaşılan sesten kanaldakilerin sesini çıkarma (benzetim)
make tarayici   # gerçek Chromium'la sesli kanal denemeleri (Playwright)
make kayip      # paket kaybında RED'in etkisi (gerçek Chromium, araya paket düşüren UDP aracısı)
```

`main`'e her gönderimde GitHub Actions arayüz, ses çıkarma ve paket kaybı denemelerini çalıştırır,
imajı derler, sunucu ve tarayıcı denemelerini imaja karşı çalıştırır, `ghcr.io`'ya yükler ve sürüm
çıkarır.

Yapı: `sunucu/` (Node: web, sohbet, signaling, coturn yönetimi, SQLite), `web/` (düz HTML/CSS/JS),
`kurulum/` (kurulum betiği, Caddy örneği), `test/`. WebSocket protokolü `sunucu/sunucu.js` içinde
açıklanmıştır.

## Güvenlik

- Depoda gizli bilgi yoktur. Beyaz liste anahtarları yalnızca sunucudaki veritabanında ve kişinin
  tarayıcısında durur. TURN sırrı her açılışta yeniden üretilir ve konteynerin dışına yazılmaz.
- `ILK_ANAHTAR` yalnızca testler içindir, üretimde boş kalmalıdır. CI'daki anahtar herkesin bildiği bir
  test değeridir.
- Ses, görüntü ve dosyaların içeriği sunucuya gelmez ve hiçbir yere kaydedilmez; yalnızca yazılı mesajlar
  ve paylaşılan dosyaların adı/boyutu saklanır.

## Sınırlar

- Ses ve yayın mesh ile taşınır: herkes kanaldaki herkese ayrı akış gönderir, bu yüzden kanal başına
  ~10 kişi. Ekran paylaşan, izleyen her kişiye ayrı görüntü gönderir (tavan yok, her bağlantının hızını
  tarayıcı ağa göre ayarlar; sunucu üzerinden (TURN) giden bağlantıda en çok 3 Mbit/s); görüntüyü
  kapatana ve ekransız paylaşımda kimseye gönderilmez. Paylaşılan ses kişi
  başı varsayılan 192 kbps (yedekle hatta ~390), en çok 320 (yedeksiz): telefonla mobil veriden
  dinleyen için saatte ~175 MB ya da ~145 MB. Konuşma RED'le hatta ~150-190 kbps. Daha
  kalabalık odalar için SFU gerekir.
- Ekran ve ses paylaşımı tarayıcıya bağlıdır: Chrome/Edge'de en iyisi (sekmenin sesi her işletim
  sisteminde, tüm bilgisayarın sesi Windows'ta "Tüm ekran" seçilince). Firefox ve Safari ekranla
  birlikte ses vermez: ses bir ses aygıtından alınır (Linux'ta "Monitor of …"; Windows'ta "Stereo
  Karışımı" açılmalı, Mac'te BlackHole gibi sanal bir aygıt gerekir). Telefon tarayıcılarının çoğu hiç
  paylaşamaz. İzlemek ve dinlemek her yerde olur. Hoparlörden dinleyenin mikrofonu çalan sesi de alır;
  kulaklık önerilir.
- Konuşma algılayan kulaklıklar (AirPods'un Konuşma Farkındalığı, Sony'nin Speak-to-Chat'i, Pixel Buds,
  Galaxy Buds'ın ses algılaması) takan kişi konuşunca çalan sesi kısar ya da durdurur, konuşma bitince
  birkaç saniyede geri getirir: paylaşılan müzik "konuşunca kısılıyor" gibi duyulur. Bu kulaklığın
  özelliğidir; ayarlarından kapatılır.
- P2P dosya, paylaşanın sayfası açıkken alınabilir. Chrome/Edge (masaüstü) büyük dosyayı doğrudan seçilen
  yere yazar; diğer tarayıcılar önce tarayıcının dosya alanına (kotası diskin bir kısmı) yazar.
- TURN'den geçen ses ve görüntü sunucunun bant genişliğini kullanır (kişi başı konuşma ~200 kbps,
  paylaşılan ses ~390 kbps'ye kadar, ekran en çok 3 Mbit/s); TURN'den geçen dosya aktarımı ~0,5 MB/sn
  ile sınırlıdır (doğrudan bağlanabilenler sınırsız). Yalnızca IPv4.
