package ses

// Kayıplara karşı yedek (RED, RFC 2198): her ses paketi bir önceki Opus çerçevesinin kopyasını da
// taşır. Tarayıcılar (libwebrtc) yalnızca bir önceki çerçeveyi taşır; paket 1200 baytı geçmez.

// RedBlok: RED paketinin bir bloğu.
type RedBlok struct {
	PT       uint8
	Geri     uint32 // birincil bloğa göre zaman farkı (örnek)
	Veri     []byte
	Birincil bool
}

// RedCoz: RED yükünü bloklarına ayır (yedekler önce, birincil en sonda).
func RedCoz(yuk []byte) ([]RedBlok, bool) {
	type bas struct {
		pt   uint8
		geri uint32
		boy  int
	}
	var baslar []bas
	i := 0
	for {
		if i >= len(yuk) {
			return nil, false
		}
		if yuk[i]&0x80 == 0 {
			baslar = append(baslar, bas{pt: yuk[i] & 0x7f, boy: -1})
			i++
			break
		}
		if i+4 > len(yuk) {
			return nil, false
		}
		geri := uint32(yuk[i+1])<<6 | uint32(yuk[i+2])>>2
		boy := int(yuk[i+2]&0x03)<<8 | int(yuk[i+3])
		baslar = append(baslar, bas{pt: yuk[i] & 0x7f, geri: geri, boy: boy})
		i += 4
		if len(baslar) > 8 {
			return nil, false
		}
	}
	bloklar := make([]RedBlok, 0, len(baslar))
	for k, b := range baslar {
		if b.boy < 0 {
			bloklar = append(bloklar, RedBlok{PT: b.pt, Veri: yuk[i:], Birincil: true})
			break
		}
		if i+b.boy > len(yuk) {
			return nil, false
		}
		bloklar = append(bloklar, RedBlok{PT: b.pt, Geri: b.geri, Veri: yuk[i : i+b.boy]})
		i += b.boy
		_ = k
	}
	return bloklar, true
}

// RedKur: birincil çerçeve ve (varsa) bir önceki çerçeveden RED yükü. onceki nil ise ya da sığmıyorsa
// yalnızca birincil blok gider (tarayıcılar da böyle yapar).
func RedKur(pt uint8, birincil, onceki []byte, geri uint32) []byte {
	if len(onceki) == 0 || geri == 0 || geri > 0x3fff || len(onceki) > 0x3ff || 5+len(onceki)+len(birincil) > 1200 {
		y := make([]byte, 0, 1+len(birincil))
		y = append(y, pt&0x7f)
		return append(y, birincil...)
	}
	y := make([]byte, 0, 5+len(onceki)+len(birincil))
	y = append(y, 0x80|pt&0x7f, byte(geri>>6), byte(geri&0x3f)<<2|byte(len(onceki)>>8), byte(len(onceki)))
	y = append(y, pt&0x7f)
	y = append(y, onceki...)
	return append(y, birincil...)
}
