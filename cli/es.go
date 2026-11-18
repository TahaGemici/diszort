package main

import (
	"encoding/json"
	"math/rand"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf16"

	"github.com/TahaGemici/diszort/cli/ses"
	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// Sesli kanaldaki bir eş: onunla bir RTCPeerConnection. Kanallar (web'deki sırayla): 1. ses =
// mikrofon, 2. ses = paylaşımın sesi (stereo), görüntü = ekran. Her çiftte teklifi adı (UTF-16 sırasıyla)
// büyük olan verir. Her bağlantının bir "oturum" kimliği vardır (teklif eden üretir); eski bağlantıya ait
// yanıt/adaylar bununla ayıklanır. Bkz. web/ana.js "sesli kanal: eşler".

type bekleyenAday struct {
	oturum string
	aday   webrtc.ICECandidateInit
}

type Es struct {
	u        *Uygulama
	ad       string
	teklifci bool
	pc       *webrtc.PeerConnection
	oturum   string

	trMik, trPay, trGoruntu *webrtc.RTPTransceiver
	mikIz, payIz            *sesIzi
	goruntuIz               *webrtc.TrackLocalStaticSample
	izlerEklendi            bool

	adaylar       []bekleyenAday
	olusturma     time.Time
	sorunBasi     time.Time
	sonKurtarma   time.Time
	sonYenile     time.Time
	bekleniyor    time.Time
	teklifZamani  time.Time
	baglandiZaman time.Time
	kurtarma      int
	sonTeklif     string
	redKapali     bool
	izliyor       bool // o, benim ekranımı izliyor
	turnYenile    bool
	sonTip        string // "P2P" | "TURN" | ""
	rtt           float64
	durum         webrtc.PeerConnectionState

	mikKaynak, payKaynak *ses.Kaynak
	remb                 atomic.Uint64 // görüntü için alıcının tahmini (bit/sn)
	mikKayip             atomic.Uint32 // alıcının bildirdiği kayıp (‰)
	payKayip             atomic.Uint32
}

// adBuyukMu: JavaScript'in dize karşılaştırması (UTF-16 kod birimleri): web'le aynı teklif sırası.
func adBuyukMu(a, b string) bool {
	x, y := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(x) && i < len(y); i++ {
		if x[i] != y[i] {
			return x[i] > y[i]
		}
	}
	return len(x) > len(y)
}

func (u *Uygulama) esYap(ad string) *Es {
	return &Es{u: u, ad: ad, teklifci: adBuyukMu(u.ben, ad), olusturma: time.Now(), izliyor: true}
}

// ---------------------------------------------------------------- giden ses izi

// sesIzi: Opus (ya da karşı taraf istiyorsa RED) gönderen iz. Kodlanmış çerçeveler ses motorundan
// gelir; her eşin bağlantısı kendi izini (SSRC, sıra, zaman damgası) taşır.
type sesIzi struct {
	tur       string
	mu        sync.Mutex
	yaz       webrtc.TrackLocalWriter
	ssrc      uint32
	opusPT    uint8
	redPT     uint8
	redIstek  bool
	seq       uint16
	ts        uint32
	sonZaman  time.Time
	sonSure   int
	onceki    []byte
	oncekiTs  uint32
	oncekiVar bool
}

func yeniSesIzi(tur string) *sesIzi {
	return &sesIzi{tur: tur, seq: uint16(rand.Uint32()), ts: rand.Uint32()}
}

func (s *sesIzi) Bind(c webrtc.TrackLocalContext) (webrtc.RTPCodecParameters, error) {
	var opus *webrtc.RTPCodecParameters
	var red uint8
	for _, k := range c.CodecParameters() {
		switch strings.ToLower(k.MimeType) {
		case "audio/opus":
			if opus == nil {
				kk := k
				opus = &kk
			}
		case "audio/red":
			if red == 0 {
				red = uint8(k.PayloadType)
			}
		}
	}
	if opus == nil {
		return webrtc.RTPCodecParameters{}, webrtc.ErrUnsupportedCodec
	}
	s.mu.Lock()
	s.yaz = c.WriteStream()
	s.ssrc = uint32(c.SSRC())
	s.opusPT = uint8(opus.PayloadType)
	s.redPT = red
	s.mu.Unlock()
	return *opus, nil
}

func (s *sesIzi) Unbind(webrtc.TrackLocalContext) error {
	s.mu.Lock()
	s.yaz = nil
	s.mu.Unlock()
	return nil
}

func (s *sesIzi) ID() string                { return s.tur }
func (s *sesIzi) RID() string               { return "" }
func (s *sesIzi) StreamID() string          { return "diszort-" + s.tur }
func (s *sesIzi) Kind() webrtc.RTPCodecType { return webrtc.RTPCodecTypeAudio }

// kodekleriGuncelle: yeniden anlaşmada karşı taraf RED'i bırakmış/eklemiş olabilir.
func (s *sesIzi) kodekleriGuncelle(snd *webrtc.RTPSender) {
	if snd == nil {
		return
	}
	var red uint8
	var opus uint8
	for _, k := range snd.GetParameters().Codecs {
		switch strings.ToLower(k.MimeType) {
		case "audio/red":
			if red == 0 {
				red = uint8(k.PayloadType)
			}
		case "audio/opus":
			if opus == 0 {
				opus = uint8(k.PayloadType)
			}
		}
	}
	s.mu.Lock()
	s.redPT = red
	if opus != 0 {
		s.opusPT = opus
	}
	s.mu.Unlock()
}

func (s *sesIzi) redAyarla(v bool) {
	s.mu.Lock()
	s.redIstek = v
	s.mu.Unlock()
}

// gonder: bir Opus çerçevesi (sure: örnek). basla: sessizlikten sonraki ilk çerçeve (zaman damgası
// geçen süre kadar ilerler, RTP işaret biti).
func (s *sesIzi) gonder(cerceve []byte, sure int, basla bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.yaz == nil {
		return
	}
	simdi := time.Now()
	if !s.sonZaman.IsZero() {
		if basla || simdi.Sub(s.sonZaman) > 200*time.Millisecond {
			adim := uint32(simdi.Sub(s.sonZaman).Seconds()*48000) / 960 * 960
			s.ts += max(adim, uint32(s.sonSure))
			s.oncekiVar = false
			basla = true
		} else {
			s.ts += uint32(s.sonSure)
		}
	}
	s.sonZaman = simdi
	s.sonSure = sure
	pt := s.opusPT
	yuk := cerceve
	if s.redIstek && s.redPT != 0 {
		var onceki []byte
		var geri uint32
		if s.oncekiVar {
			onceki, geri = s.onceki, s.ts-s.oncekiTs
		}
		yuk = ses.RedKur(s.opusPT, cerceve, onceki, geri)
		pt = s.redPT
	}
	s.onceki, s.oncekiTs, s.oncekiVar = cerceve, s.ts, true
	s.seq++
	s.yaz.WriteRTP(&rtp.Header{Version: 2, Marker: basla, PayloadType: pt, SequenceNumber: s.seq, Timestamp: s.ts, SSRC: s.ssrc}, yuk)
}

// ---------------------------------------------------------------- WebRTC kurulumu

func (u *Uygulama) api() (*webrtc.API, error) {
	me := &webrtc.MediaEngine{}
	if err := me.RegisterCodec(webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2, SDPFmtpLine: "minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1"}, PayloadType: 111}, webrtc.RTPCodecTypeAudio); err != nil {
		return nil, err
	}
	if err := me.RegisterCodec(webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: "audio/red", ClockRate: 48000, Channels: 2, SDPFmtpLine: "111/111"}, PayloadType: 63}, webrtc.RTPCodecTypeAudio); err != nil {
		return nil, err
	}
	geri := []webrtc.RTCPFeedback{{Type: "goog-remb"}, {Type: "ccm", Parameter: "fir"}, {Type: "nack"}, {Type: "nack", Parameter: "pli"}}
	if err := me.RegisterCodec(webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000, RTCPFeedback: geri}, PayloadType: 96}, webrtc.RTPCodecTypeVideo); err != nil {
		return nil, err
	}
	ir := &interceptor.Registry{}
	if err := webrtc.ConfigureNack(me, ir); err != nil {
		return nil, err
	}
	if err := webrtc.ConfigureRTCPReports(ir); err != nil {
		return nil, err
	}
	if err := webrtc.ConfigureStatsInterceptor(ir); err != nil {
		return nil, err
	}
	se := webrtc.SettingEngine{}
	se.SetICETimeouts(5*time.Second, 25*time.Second, 2*time.Second)
	return webrtc.NewAPI(webrtc.WithMediaEngine(me), webrtc.WithInterceptorRegistry(ir), webrtc.WithSettingEngine(se)), nil
}

func (u *Uygulama) pcAyari() webrtc.Configuration {
	a := webrtc.Configuration{ICEServers: u.ice, BundlePolicy: webrtc.BundlePolicyMaxBundle, RTCPMuxPolicy: webrtc.RTCPMuxPolicyRequire}
	if u.zorlaTurn() {
		a.ICETransportPolicy = webrtc.ICETransportPolicyRelay
	}
	return a
}

func (u *Uygulama) zorlaTurn() bool { return getenvBool("DISZORT_ZORLA_TURN") }

// pcKur: eşe yeni bir bağlantı. Teklif eden yeni bir oturum üretir ve kanalları açar; yanıtlayan
// teklifteki oturumu alır, kanalları teklif kurar.
func (u *Uygulama) pcKur(es *Es, oturum string) {
	u.pcKapat(es)
	api, err := u.api()
	if err != nil {
		u.gunluk("webrtc: " + err.Error())
		return
	}
	pc, err := api.NewPeerConnection(u.pcAyari())
	if err != nil {
		u.gunluk("RTCPeerConnection kurulamadı: " + err.Error())
		return
	}
	es.pc = pc
	es.sonTeklif = ""
	es.oturum = oturum
	if es.oturum == "" && es.teklifci {
		es.oturum = rastgeleKimlik(12)
	}
	es.olusturma = time.Now()
	es.sorunBasi = time.Now()
	es.izlerEklendi = false
	es.durum = webrtc.PeerConnectionStateNew
	es.mikIz = yeniSesIzi("mik")
	es.payIz = yeniSesIzi("pay")
	es.goruntuIz, _ = webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000}, "goruntu", "diszort-goruntu")
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		aday := c.ToJSON()
		u.calistir(func() {
			if es.pc == pc {
				u.gonder(map[string]any{"type": "ice", "to": es.ad, "ice": aday, "oturum": es.oturum})
			}
		})
	})
	pc.OnTrack(func(tr *webrtc.TrackRemote, r *webrtc.RTPReceiver) {
		u.calistir(func() {
			if es.pc == pc {
				u.izGeldi(es, tr, r)
			} else {
				go izBosalt(tr)
			}
		})
	})
	pc.OnConnectionStateChange(func(d webrtc.PeerConnectionState) {
		u.calistir(func() {
			if es.pc == pc {
				es.durum = d
				u.esDurumDegisti(es)
			}
		})
	})
	if es.teklifci {
		ekle := func(iz webrtc.TrackLocal) *webrtc.RTPTransceiver {
			tr, err := pc.AddTransceiverFromTrack(iz, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendrecv})
			if err != nil {
				u.gunluk("kanal açılamadı: " + err.Error())
			}
			return tr
		}
		es.trMik = ekle(es.mikIz)
		es.trPay = ekle(es.payIz)
		es.trGoruntu = ekle(es.goruntuIz)
		es.izlerEklendi = true
		u.rtcpOkuyuculari(es)
		u.izleriKaydet()
		u.teklifVer(es, false)
	}
}

// izleriEkle (yanıtlayan): teklifin kanallarına izlerimizi bağla (sırasıyla mikrofon, paylaşım sesi,
// görüntü). İz bağlanmadan yanıt verilirse Firefox "recvonly" anlar ve ses tek yöne düşer.
func (u *Uygulama) izleriEkle(es *Es) error {
	if es.izlerEklendi {
		return nil
	}
	var sesler []*webrtc.RTPTransceiver
	var goruntu *webrtc.RTPTransceiver
	for _, t := range es.pc.GetTransceivers() {
		if t.Kind() == webrtc.RTPCodecTypeAudio {
			sesler = append(sesler, t)
		} else if t.Kind() == webrtc.RTPCodecTypeVideo && goruntu == nil {
			goruntu = t
		}
	}
	if len(sesler) < 2 || goruntu == nil {
		return errTeklifEksik
	}
	if _, err := es.pc.AddTrack(es.mikIz); err != nil {
		return err
	}
	if _, err := es.pc.AddTrack(es.payIz); err != nil {
		return err
	}
	if _, err := es.pc.AddTrack(es.goruntuIz); err != nil {
		return err
	}
	es.trMik, es.trPay, es.trGoruntu = sesler[0], sesler[1], goruntu
	es.izlerEklendi = true
	u.rtcpOkuyuculari(es)
	u.izleriKaydet()
	return nil
}

type hata string

func (h hata) Error() string { return string(h) }

const errTeklifEksik = hata("teklifte mikrofon, yayın sesi ve görüntü kanalları yok")

// rtcpOkuyuculari: gönderenlerin RTCP'si (okunmazsa yeniden gönderim ve raporlar işlemez): görüntüde
// anahtar kare istekleri ve alıcının bant tahmini (REMB), seste alıcının bildirdiği kayıp.
func (u *Uygulama) rtcpOkuyuculari(es *Es) {
	oku := func(s *webrtc.RTPSender, tur string) {
		if s == nil {
			return
		}
		go func() {
			for {
				paketler, _, err := s.ReadRTCP()
				if err != nil {
					return
				}
				for _, p := range paketler {
					switch p := p.(type) {
					case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
						if tur == "goruntu" {
							u.anahtarKareIste()
						}
					case *rtcp.ReceiverEstimatedMaximumBitrate:
						if tur == "goruntu" {
							es.remb.Store(uint64(p.Bitrate))
						}
					case *rtcp.ReceiverReport:
						for _, r := range p.Reports {
							kayip := uint32(r.FractionLost) * 1000 / 256
							if tur == "mik" {
								es.mikKayip.Store(kayip)
							} else if tur == "pay" {
								es.payKayip.Store(kayip)
							}
						}
					}
				}
			}
		}()
	}
	if es.trMik != nil {
		oku(es.trMik.Sender(), "mik")
	}
	if es.trPay != nil {
		oku(es.trPay.Sender(), "pay")
	}
	if es.trGoruntu != nil {
		oku(es.trGoruntu.Sender(), "goruntu")
	}
}

func izBosalt(tr *webrtc.TrackRemote) {
	for {
		if _, _, err := tr.ReadRTP(); err != nil {
			return
		}
	}
}

// izGeldi: eşten gelen iz. Görüntü gösterilmez (okunup atılır; izlemediğimizi zaten söyledik).
func (u *Uygulama) izGeldi(es *Es, tr *webrtc.TrackRemote, r *webrtc.RTPReceiver) {
	if tr.Kind() == webrtc.RTPCodecTypeVideo {
		go izBosalt(tr)
		return
	}
	yayin := false
	if es.trPay != nil && es.trPay.Receiver() == r {
		yayin = true
	} else if es.trMik == nil || es.trMik.Receiver() != r {
		// Kanalların sırasından bul.
		var sesler []*webrtc.RTPTransceiver
		for _, t := range es.pc.GetTransceivers() {
			if t.Kind() == webrtc.RTPCodecTypeAudio {
				sesler = append(sesler, t)
			}
		}
		yayin = len(sesler) > 1 && sesler[1].Receiver() == r
	}
	uzak, err := ses.YeniUzakSes()
	if err != nil {
		go izBosalt(tr)
		return
	}
	k := &ses.Kaynak{Ses: uzak}
	if yayin {
		if es.payKaynak != nil {
			u.motor.KaynakCikar(es.payKaynak)
		}
		es.payKaynak = k
	} else {
		if es.mikKaynak != nil {
			u.motor.KaynakCikar(es.mikKaynak)
		}
		es.mikKaynak = k
	}
	u.esSesUygula(es)
	u.motor.KaynakEkle(k)
	var opusPT, redPT uint8
	for _, c := range r.GetParameters().Codecs {
		switch strings.ToLower(c.MimeType) {
		case "audio/opus":
			if opusPT == 0 {
				opusPT = uint8(c.PayloadType)
			}
		case "audio/red":
			if redPT == 0 {
				redPT = uint8(c.PayloadType)
			}
		}
	}
	go func() {
		for {
			p, _, err := tr.ReadRTP()
			if err != nil {
				break
			}
			uzak.PaketGeldi(p.Timestamp, p.Payload, redPT != 0 && p.PayloadType == redPT, opusPT)
		}
		u.calistir(func() {
			u.motor.KaynakCikar(k)
			uzak.Kapat()
			if es.mikKaynak == k {
				es.mikKaynak = nil
			}
			if es.payKaynak == k {
				es.payKaynak = nil
			}
		})
	}()
}

// esSesUygula: kişinin ses seviyesi ve susturması (yalnızca bende), sağırlık.
func (u *Uygulama) esSesUygula(es *Es) {
	k := u.ayar.kisi(es.ad)
	if es.mikKaynak != nil {
		g := float64(k.Seviye) / 100
		if k.Sustur {
			g = 0
		}
		es.mikKaynak.Kazanc(g)
	}
	if es.payKaynak != nil {
		g := float64(k.YayinSeviye) / 100
		if k.YayinSustur {
			g = 0
		}
		es.payKaynak.Kazanc(g)
	}
}

func (u *Uygulama) pcKapat(es *Es) {
	if es.pc != nil {
		pc := es.pc
		es.pc = nil
		go pc.Close()
	}
	if es.mikKaynak != nil {
		u.motor.KaynakCikar(es.mikKaynak)
		es.mikKaynak.Ses.Kapat()
		es.mikKaynak = nil
	}
	if es.payKaynak != nil {
		u.motor.KaynakCikar(es.payKaynak)
		es.payKaynak.Ses.Kapat()
		es.payKaynak = nil
	}
	es.trMik, es.trPay, es.trGoruntu = nil, nil, nil
	es.mikIz, es.payIz, es.goruntuIz = nil, nil, nil
	es.izlerEklendi = false
	es.sonTip = ""
	u.izleriKaydet()
}

func esKapandi(es *Es) bool {
	return es.pc == nil || es.pc.SignalingState() == webrtc.SignalingStateClosed
}

func (u *Uygulama) aciklamaGonder(es *Es) {
	if es.pc == nil || es.pc.LocalDescription() == nil {
		return
	}
	d := es.pc.LocalDescription()
	u.gonder(map[string]any{"type": "sdp", "to": es.ad, "sdp": map[string]string{"type": d.Type.String(), "sdp": d.SDP}, "oturum": es.oturum})
}

func esSaglikli(es *Es) bool {
	if esKapandi(es) {
		return false
	}
	d := es.pc.ConnectionState()
	if d == webrtc.PeerConnectionStateConnected {
		return true
	}
	return (d == webrtc.PeerConnectionStateNew || d == webrtc.PeerConnectionStateConnecting) && time.Since(es.olusturma) < 15*time.Second
}

func (u *Uygulama) teklifVer(es *Es, iceYenidenBaslat bool) {
	pc := es.pc
	if pc == nil || pc.SignalingState() != webrtc.SignalingStateStable || !u.bagli {
		return
	}
	teklif, err := pc.CreateOffer(&webrtc.OfferOptions{ICERestart: iceYenidenBaslat})
	if err == nil {
		err = pc.SetLocalDescription(teklif)
	}
	if err != nil {
		u.gunluk("teklif " + es.ad + ": " + err.Error())
		u.taniGonder(map[string]any{"olay": "teklif-hata", "es": es.ad, "metin": kisalt(err.Error(), 160), "iceYenile": iceYenidenBaslat})
		return
	}
	es.teklifZamani = time.Now()
	u.aciklamaGonder(es)
}

func (u *Uygulama) sdpGeldi(ad string, sdp *webrtc.SessionDescription, oturum string) {
	if u.sesKanal == "" || ad == "" || sdp == nil {
		return
	}
	es := u.esler[ad]
	if es == nil {
		es = u.esOlustur(ad)
	}
	es.bekleniyor = time.Time{}
	if err := u.sdpIsle(es, sdp, oturum); err != nil {
		u.gunluk("sdp " + ad + ": " + err.Error())
		u.taniGonder(map[string]any{"olay": "sdp-hata", "es": ad, "tur": sdp.Type.String(), "metin": kisalt(err.Error(), 200)})
	}
}

func (u *Uygulama) sdpIsle(es *Es, sdp *webrtc.SessionDescription, oturum string) error {
	if u.esler[es.ad] != es {
		return nil
	}
	switch sdp.Type {
	case webrtc.SDPTypeOffer:
		if es.teklifci {
			return nil
		}
		if esKapandi(es) || es.oturum != oturum {
			u.pcKur(es, oturum)
		}
		pc := es.pc
		if pc == nil {
			return nil
		}
		// Aynı teklif yeniden geldi (yanıtımız kayboldu): yeniden uygulama, yanıtı yinele.
		if es.sonTeklif == sdp.SDP && pc.SignalingState() == webrtc.SignalingStateStable && pc.LocalDescription() != nil && pc.LocalDescription().Type == webrtc.SDPTypeAnswer {
			u.aciklamaGonder(es)
			return nil
		}
		if pc.SignalingState() != webrtc.SignalingStateStable {
			if err := pc.SetLocalDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeRollback}); err != nil {
				u.pcKur(es, oturum)
				pc = es.pc
				if pc == nil {
					return nil
				}
			}
		}
		if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: sdp.SDP}); err != nil {
			return err
		}
		es.sonTeklif = sdp.SDP
		u.adaylariUygula(es)
		if err := u.izleriEkle(es); err != nil {
			return err
		}
		yanit, err := pc.CreateAnswer(nil)
		if err != nil {
			return err
		}
		if err := pc.SetLocalDescription(yanit); err != nil {
			return err
		}
		u.aciklamaGonder(es)
		u.redleriAyarla(es)
	case webrtc.SDPTypeAnswer:
		pc := es.pc
		if !es.teklifci || pc == nil || es.oturum != oturum || pc.SignalingState() != webrtc.SignalingStateHaveLocalOffer {
			return nil
		}
		if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: sdp.SDP}); err != nil {
			// Yanıt uygulanamadı (karşı taraf bağlantıyı sıfırdan kurdu): baştan kur.
			u.esYenidenKur(es)
			return err
		}
		u.adaylariUygula(es)
		u.redleriAyarla(es)
	}
	return nil
}

func (u *Uygulama) adaylariUygula(es *Es) {
	if es.pc == nil || es.pc.RemoteDescription() == nil {
		return
	}
	bekleyen := es.adaylar
	es.adaylar = nil
	for _, b := range bekleyen {
		if b.oturum != es.oturum {
			continue
		}
		es.pc.AddICECandidate(b.aday)
	}
}

func (u *Uygulama) iceGeldi(ad string, ham json.RawMessage, oturum string) {
	es := u.esler[ad]
	if es == nil || len(ham) == 0 {
		return
	}
	var aday webrtc.ICECandidateInit
	if json.Unmarshal(ham, &aday) != nil {
		return
	}
	if es.pc != nil && es.oturum == oturum && es.pc.RemoteDescription() != nil {
		es.pc.AddICECandidate(aday)
	} else if len(es.adaylar) < 200 {
		es.adaylar = append(es.adaylar, bekleyenAday{oturum: oturum, aday: aday})
	}
}

// yenileGeldi: yanıtlayan "bağlantımız bozuk" diyor (yalnızca teklif eden alır). tam: baştan kur.
// teklif: karşı taraf ses kalitesini değiştirdi, yalnızca yeni teklif istiyor.
func (u *Uygulama) yenileGeldi(ad, oturum string, tam, teklif bool) {
	if u.sesKanal == "" || ad == "" || ad == u.ben {
		return
	}
	if teklif {
		es := u.esler[ad]
		if es != nil && es.teklifci && es.pc != nil && !esKapandi(es) && oturum == es.oturum && es.pc.SignalingState() == webrtc.SignalingStateStable && es.pc.RemoteDescription() != nil {
			u.teklifVer(es, false)
		}
		return
	}
	es := u.esler[ad]
	if es == nil {
		es = u.esOlustur(ad)
	}
	es.bekleniyor = time.Time{}
	if !es.teklifci {
		return
	}
	if tam {
		u.taniGonder(map[string]any{"olay": "yeniden-kur-istendi", "es": es.ad})
		u.esYenidenKur(es)
		return
	}
	pc := es.pc
	if pc != nil && !esKapandi(es) && pc.SignalingState() == webrtc.SignalingStateHaveLocalOffer && pc.LocalDescription() != nil {
		u.aciklamaGonder(es)
		return
	}
	if pc != nil && !esKapandi(es) && oturum != "" && oturum == es.oturum && pc.RemoteDescription() != nil && pc.SignalingState() == webrtc.SignalingStateStable && es.kurtarma < 2 {
		es.kurtarma++
		es.sonKurtarma = time.Now()
		u.iceYenile(es)
		return
	}
	u.esYenidenKur(es)
}

func (u *Uygulama) yenileIste(es *Es, zorla bool) {
	if !u.bagli || es.teklifci {
		return
	}
	if !zorla && time.Since(es.sonYenile) < 6*time.Second {
		return
	}
	es.sonYenile = time.Now()
	u.gonder(map[string]any{"type": "yenile", "to": es.ad, "oturum": es.oturum})
}

func (u *Uygulama) esYenidenKur(es *Es) {
	if !es.teklifci || u.sesKanal == "" {
		return
	}
	u.taniGonder(map[string]any{"olay": "yeniden-kur", "es": es.ad, "eski": es.oturum})
	u.pcKur(es, "")
}

func (u *Uygulama) esGeriDondu(es *Es) {
	if es.pc == nil {
		return
	}
	if es.turnYenile {
		es.turnYenile = false
		if es.teklifci {
			u.taniGonder(map[string]any{"olay": "turn-yenilendi", "es": es.ad})
			u.iceYenile(es)
		}
		return
	}
	if es.teklifci && es.pc.SignalingState() == webrtc.SignalingStateHaveLocalOffer && es.pc.LocalDescription() != nil {
		es.teklifZamani = time.Now()
		u.aciklamaGonder(es)
	}
}

func (es *Es) sunuculariTazele() {
	if es.pc == nil || es.pc.SignalingState() == webrtc.SignalingStateClosed || len(es.u.ice) == 0 {
		return
	}
	a := es.pc.GetConfiguration()
	a.ICEServers = es.u.ice
	es.pc.SetConfiguration(a)
}

func (u *Uygulama) iceYenile(es *Es) {
	if es.pc == nil || es.pc.SignalingState() != webrtc.SignalingStateStable || !es.teklifci {
		return
	}
	es.sunuculariTazele()
	u.taniGonder(map[string]any{"olay": "ice-yenile", "es": es.ad, "deneme": es.kurtarma})
	u.teklifVer(es, true)
}

func (u *Uygulama) esDurumDegisti(es *Es) {
	d := es.durum
	u.taniGonder(map[string]any{"olay": "durum", "es": es.ad, "durum": d.String()})
	if d == webrtc.PeerConnectionStateConnected {
		es.sorunBasi = time.Time{}
		es.kurtarma = 0
		es.baglandiZaman = time.Now()
		u.redleriAyarla(es)
		u.izleGerekiyorsa(es)
		u.izleriKaydet()
		u.anahtarKareIste()
		go u.esIstatistik(es)
	} else if es.sorunBasi.IsZero() {
		es.sorunBasi = time.Now()
	}
	if d == webrtc.PeerConnectionStateFailed {
		u.kurtarmaTuru()
	}
}

// redleriAyarla: bu eşe RED gönderilsin mi (ayar, karşının desteği, RED'i bırakmış mı).
func (u *Uygulama) redleriAyarla(es *Es) {
	if es.mikIz != nil && es.trMik != nil {
		es.mikIz.kodekleriGuncelle(es.trMik.Sender())
		es.mikIz.redAyarla(u.ayar.Ses.MikRed && !es.redKapali)
	}
	if es.payIz != nil && es.trPay != nil {
		es.payIz.kodekleriGuncelle(es.trPay.Sender())
		es.payIz.redAyarla(u.ayar.Ses.YayinRed && u.ayar.Ses.YayinSes <= redSiganHiz && !es.redKapali)
	}
}

// esIstatistik: bağlantı türü (P2P/TURN) ve gidiş-dönüş süresi.
func (u *Uygulama) esIstatistik(es *Es) {
	pc := es.pc
	if pc == nil {
		return
	}
	rapor := pc.GetStats()
	tip, rtt := "", 0.0
	for _, s := range rapor {
		cift, ok := s.(webrtc.ICECandidatePairStats)
		if !ok || !cift.Nominated || cift.State != webrtc.StatsICECandidatePairStateSucceeded {
			continue
		}
		rtt = cift.CurrentRoundTripTime
		tip = "P2P"
		for _, id := range []string{cift.LocalCandidateID, cift.RemoteCandidateID} {
			if a, ok := rapor[id].(webrtc.ICECandidateStats); ok && a.CandidateType == webrtc.ICECandidateTypeRelay {
				tip = "TURN"
			}
		}
	}
	u.calistir(func() {
		if es.pc == pc {
			if tip != "" {
				es.sonTip = tip
			}
			es.rtt = rtt
		}
	})
}

func kisalt(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}
