// maxx statusline renderer — the LOOK, in Go + lipgloss.
// Reads Claude Code's stdin JSON (real rate_limits = the session/weekly walls, same
// numbers as /usage) + ~/.tokenmaxx/state.json the brain writes (advice / sprint /
// intent), then renders the cockpit: M mark │ gauges │ coach.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
	colorful "github.com/lucasb-eyer/go-colorful"
	"github.com/muesli/termenv"
)

// ─── palette (matches the python _hsl(270, …) so the brand is identical) ────────
func hueToRGB(m1, m2, hue float64) float64 {
	hue = math.Mod(hue, 1)
	if hue < 0 {
		hue++
	}
	switch {
	case hue < 1.0/6:
		return m1 + (m2-m1)*hue*6
	case hue < 0.5:
		return m2
	case hue < 2.0/3:
		return m1 + (m2-m1)*(2.0/3-hue)*6
	default:
		return m1
	}
}

func hsl(h, s, l float64) lipgloss.Color {
	hh := h / 360
	var r, g, b float64
	if s == 0 {
		r, g, b = l, l, l
	} else {
		var m2 float64
		if l <= 0.5 {
			m2 = l * (1 + s)
		} else {
			m2 = l + s - l*s
		}
		m1 := 2*l - m2
		r = hueToRGB(m1, m2, hh+1.0/3)
		g = hueToRGB(m1, m2, hh)
		b = hueToRGB(m1, m2, hh-1.0/3)
	}
	return lipgloss.Color(fmt.Sprintf("#%02x%02x%02x",
		int(math.Round(r*255)), int(math.Round(g*255)), int(math.Round(b*255))))
}

var (
	BRAND = hsl(270, 0.58, 0.52)
	DIM   = hsl(270, 0.30, 0.50)
	TRACK = hsl(270, 0.35, 0.80)
	BG    = hsl(270, 0.55, 0.88)
	GREEN = lipgloss.Color("#2fa84a")
	AMBER = lipgloss.Color("#d69e2e")
	RED   = lipgloss.Color("#e0433c")
)

// fg renders text in a color on the panel background (so the band stays unbroken).
func fg(c lipgloss.Color, s string) string {
	return lipgloss.NewStyle().Foreground(c).Background(BG).Render(s)
}

// fg2 renders text with an explicit background — used for a gauge's partial cell so
// the sub-block's unfilled half shows the rail color, not the panel band (seamless).
func fg2(fc, bc lipgloss.Color, s string) string {
	return lipgloss.NewStyle().Foreground(fc).Background(bc).Render(s)
}

// shade nudges a color's lightness (±) for gradients / sheen.
func shade(c lipgloss.Color, dl float64) lipgloss.Color {
	cc, err := colorful.Hex(string(c))
	if err != nil {
		return c
	}
	h, s, l := cc.Hsl()
	l = math.Max(0, math.Min(1, l+dl))
	return lipgloss.Color(colorful.Hsl(h, s, l).Hex())
}

// mMark: the beveled M — each block gets a top-lit vertical ramp plus a shine that
// sweeps diagonally with `phase` (time-driven), so it reads as tiled 2.5D depth.
var mPattern = []string{"█   █", "██ ██", "█ █ █", "█   █", "█   █"}

func mMarkRows(phase float64) []string {
	out := make([]string, 5)
	for r := 0; r < 5; r++ {
		var b strings.Builder
		for c, ch := range mPattern[r] {
			if ch != '█' {
				b.WriteString(fg(BG, " "))
				continue
			}
			base := 0.66 - 0.26*(float64(r)/4.0) // top lit, bottom deep
			shine := math.Max(0, 1-math.Abs((float64(c)-float64(r))-phase)/1.5)
			l := math.Min(0.98, base+0.30*shine)
			b.WriteString(fg(hsl(270, 0.64, l), "█"))
		}
		out[r] = b.String()
	}
	return out
}

// resetIn: human countdown to a unix-epoch reset time (e.g. "2h10m", "4d").
func resetIn(ts float64) string {
	if ts <= 0 {
		return ""
	}
	d := time.Until(time.Unix(int64(ts), 0))
	if d <= 0 {
		return "now"
	}
	if d.Hours() >= 24 {
		return fmt.Sprintf("%dd", int(d.Hours()/24))
	}
	if h := int(d.Hours()); h > 0 {
		return fmt.Sprintf("%dh%dm", h, int(d.Minutes())%60)
	}
	return fmt.Sprintf("%dm", int(d.Minutes()))
}

// ─── inputs ─────────────────────────────────────────────────────────────────────
type Payload struct {
	TranscriptPath string `json:"transcript_path"`
	Model          struct {
		DisplayName string `json:"display_name"`
		ID          string `json:"id"`
	} `json:"model"`
	Workspace struct {
		ProjectDir string `json:"project_dir"`
		CurrentDir string `json:"current_dir"`
	} `json:"workspace"`
	Cost struct {
		TotalCostUSD    float64 `json:"total_cost_usd"`
		TotalDurationMs float64 `json:"total_duration_ms"`
	} `json:"cost"`
	ContextWindow struct {
		Size         float64 `json:"context_window_size"`
		UsedPct      float64 `json:"used_percentage"`
		CurrentUsage struct {
			InputTokens   float64 `json:"input_tokens"`
			CacheRead     float64 `json:"cache_read_input_tokens"`
			CacheCreation float64 `json:"cache_creation_input_tokens"`
		} `json:"current_usage"`
	} `json:"context_window"`
	// the REAL rate limits (Pro/Max only, after the first API response) — matches /usage
	RateLimits *struct {
		FiveHour *struct {
			UsedPercentage float64 `json:"used_percentage"`
			ResetsAt       float64 `json:"resets_at"`
		} `json:"five_hour"`
		SevenDay *struct {
			UsedPercentage float64 `json:"used_percentage"`
			ResetsAt       float64 `json:"resets_at"`
		} `json:"seven_day"`
	} `json:"rate_limits"`
}

func home() string { h, _ := os.UserHomeDir(); return h }

func readJSON(path string, v any) bool {
	b, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	return json.Unmarshal(b, v) == nil
}

func readState() map[string]any {
	m := map[string]any{}
	readJSON(filepath.Join(home(), ".tokenmaxx", "state.json"), &m)
	return m
}

// sprint timing lives in its OWN file so the 1s renderer and the per-turn brain never
// write the same JSON — no clobbering. state.json is now brain-owned (read-only here).
func readSprint() map[string]float64 {
	m := map[string]float64{}
	readJSON(filepath.Join(home(), ".tokenmaxx", "sprint.json"), &m)
	return m
}

func writeSprint(m map[string]float64) {
	if b, err := json.Marshal(m); err == nil {
		os.WriteFile(filepath.Join(home(), ".tokenmaxx", "sprint.json"), b, 0o644)
	}
}

func sf(m map[string]any, k string) float64 {
	if v, ok := m[k].(float64); ok {
		return v
	}
	return 0
}
func ss(m map[string]any, k string) string {
	if v, ok := m[k].(string); ok {
		return v
	}
	return ""
}

// micro-sprint countdown (mins left in a 30-min block). Auto-cycles: a fresh sprint
// starts every 30 min, or after a >5min idle gap — so it never sticks at 0. Returns
// (mins left, sprint start) so the coach can detect a fresh sprint.
func sprintTimer(sp map[string]float64) (int, float64) {
	now := float64(time.Now().Unix())
	last, start := sp["sess_last"], sp["sess_start"]
	if start == 0 || now-last > 300 || now-start >= 1800 {
		start = now
	}
	sp["sess_start"], sp["sess_last"] = start, now
	m := int(math.Round(30 - (now-start)/60))
	if m < 1 {
		m = 1
	}
	return m, start
}

// git branch from .git/HEAD, walking up from the project dir.
func gitBranch(dir string) string {
	for d := dir; d != "" && d != "/"; d = filepath.Dir(d) {
		if b, err := os.ReadFile(filepath.Join(d, ".git", "HEAD")); err == nil {
			s := strings.TrimSpace(string(b))
			if strings.HasPrefix(s, "ref: refs/heads/") {
				return strings.TrimPrefix(s, "ref: refs/heads/")
			}
			if len(s) >= 7 {
				return s[:7]
			}
			return ""
		}
	}
	return ""
}

func modelFamily(name string) string {
	l := strings.ToLower(name)
	switch {
	case strings.Contains(l, "opus"):
		return "Opus"
	case strings.Contains(l, "haiku"):
		return "Haiku"
	case strings.Contains(l, "sonnet"):
		return "Sonnet"
	}
	if r := []rune(name); len(r) > 8 {
		return string(r[:8])
	}
	return name
}

// gauge: a smooth sub-cell progress rail. The fill is a dark→bright gradient in `col`;
// 1/8-block glyphs give sub-cell precision (so 94% never reads as a full/100% bar),
// and the remainder is a solid TRACK rail. This is the lipgloss/true-color payoff.
var eighths = []string{"", "▏", "▎", "▍", "▌", "▋", "▊", "▉"}

func gauge(frac float64, width int, col lipgloss.Color) string {
	if frac < 0 {
		frac = 0
	}
	if frac > 1 {
		frac = 1
	}
	units := frac * float64(width)
	whole := int(units)
	grad := func(i int) lipgloss.Color { // dark→bright along the fill
		t := 0.0
		if width > 1 {
			t = float64(i) / float64(width-1)
		}
		return shade(col, -0.14+0.24*t)
	}
	var b strings.Builder
	for i := 0; i < whole; i++ {
		b.WriteString(fg(grad(i), "█"))
	}
	used := whole
	if whole < width { // partial cell: fill-color left, rail-color right
		if e := int((units-float64(whole))*8 + 0.5); e > 0 {
			b.WriteString(fg2(grad(whole), TRACK, eighths[e]))
			used++
		}
	}
	if used < width {
		b.WriteString(fg(TRACK, strings.Repeat("█", width-used)))
	}
	return b.String()
}

func trunc(s string, w int) string {
	r := []rune(s)
	if len(r) <= w {
		return s
	}
	if w < 1 {
		return "…"
	}
	return string(r[:w-1]) + "…"
}

func main() {
	lipgloss.SetColorProfile(termenv.TrueColor)

	var p Payload
	raw, _ := io.ReadAll(os.Stdin)
	json.Unmarshal(raw, &p)

	cols := 130
	if c := os.Getenv("COLUMNS"); c != "" {
		fmt.Sscanf(c, "%d", &cols)
	}

	// state.json (brain advice / sprint / intent) — the only sidecar cache still used
	st := readState()

	// ── compute display values ──
	ctxPct := p.ContextWindow.UsedPct
	cu := p.ContextWindow.CurrentUsage
	total := cu.InputTokens + cu.CacheRead + cu.CacheCreation
	cache := 0.0
	if total > 0 {
		cache = cu.CacheRead / total
	}
	// session + weekly = Claude's REAL rate limits, straight from stdin (matches /usage)
	quota, haveQuota := 0.0, false
	week, haveWeek := 0.0, false
	var qReset, wReset float64
	if p.RateLimits != nil {
		if fh := p.RateLimits.FiveHour; fh != nil {
			quota, qReset, haveQuota = fh.UsedPercentage/100, fh.ResetsAt, true
		}
		if sd := p.RateLimits.SevenDay; sd != nil {
			week, wReset, haveWeek = sd.UsedPercentage/100, sd.ResetsAt, true
		}
	}
	usd := p.Cost.TotalCostUSD
	fam := modelFamily(p.Model.DisplayName)
	branch := gitBranch(p.Workspace.ProjectDir)
	sp := readSprint()
	left, sprintStart := sprintTimer(sp)
	writeSprint(sp)

	// quota color — the vibe coder's wall, the only red
	qcol := GREEN
	switch {
	case quota >= 0.9:
		qcol = RED
	case quota >= 0.75:
		qcol = AMBER
	}
	wcol := GREEN
	switch {
	case week >= 0.9:
		wcol = RED
	case week >= 0.75:
		wcol = AMBER
	}
	// temp = how hot you're running (cache efficiency)
	tword, tcol := "cool", GREEN
	switch {
	case cache < 0.6:
		tword, tcol = "hot", RED
	case cache < 0.85:
		tword, tcol = "warm", AMBER
	}
	// health dot: quota OR weekly wall reds it, temp warms it; context never reds it
	hcol := GREEN
	switch {
	case quota >= 0.9 || week >= 0.9:
		hcol = RED
	case quota >= 0.75 || week >= 0.75 || cache < 0.6:
		hcol = AMBER
	}

	// narrow terminal: one compact line, no panes (avoids a broken 3-column layout)
	if cols < 88 {
		l := fg(hcol, "●")
		if haveQuota {
			l += " " + gauge(quota, 6, qcol) + fg(qcol, fmt.Sprintf(" %d%%", int(quota*100)))
		}
		l += fg(DIM, "  ") + fg(tcol, tword)
		ct, cc := coachLine(st, ctxPct, sprintStart)
		l += fg(DIM, "  ") + fg(cc, trunc(ct, cols-22))
		fmt.Println(lipgloss.NewStyle().Background(BG).Render(l))
		return
	}

	// ── pane widths ── reserve a margin: Claude Code's COLUMNS overstates the usable
	// area (it clips the last few cols + adds its own "…"), so render inside that box.
	pw := cols - 3
	if pw < 55 {
		pw = 55
	}
	inner := pw - 4 // rounded border (2) + padding (2)
	mW := 5         // the beveled M mark, on the LEFT so a right-edge clip never eats it
	cw := inner * 42 / 100 // console scales with the terminal — use the width
	if cw < 34 {
		cw = 34
	}
	if cw > 64 {
		cw = 64
	}
	hw := inner - mW - cw - 6 // two " │ " separators = 6 cols
	if hw < 12 {
		hw = 12
	}
	gw := cw - 24 // gauges grow with the console
	if gw < 8 {
		gw = 8
	}
	if gw > 26 {
		gw = 26
	}

	// ── CONSOLE pane: horizontal gauges (session / weekly / temp) + meta ──
	qv, wv := "—", "—"
	if haveQuota {
		qv = fmt.Sprintf("%d%%", int(quota*100))
	}
	if haveWeek {
		wv = fmt.Sprintf("%d%%", int(week*100))
	}
	qr, wr := "", ""
	if s := resetIn(qReset); s != "" {
		qr = " " + s
	}
	if s := resetIn(wReset); s != "" {
		wr = " " + s
	}
	scol := DIM
	if left <= 5 {
		scol = AMBER
	}
	bcap := cw - 18
	if bcap < 12 {
		bcap = 12
	}
	meta := fam
	if branch != "" {
		meta += " · " + trunc(branch, bcap)
	}
	crow := []string{
		fg(hcol, "● ") + fg(DIM, "session ") + gauge(quota, gw, qcol) + fg(qcol, " "+qv) + fg(DIM, qr),
		fg(DIM, "  weekly  ") + gauge(week, gw, wcol) + fg(wcol, " "+wv) + fg(DIM, wr),
		fg(DIM, "  temp    ") + fg(tcol, tword), // a word, not a gauge: full temp = good but full session = bad, so a bar here misleads
		fg(DIM, "  "+meta) + fg(scol, fmt.Sprintf("  sprint %dm", left)),
		fg(DIM, fmt.Sprintf("  $%.0f · ctx %d%%", usd, int(ctxPct))),
	}
	console := strings.Join(crow, "\n")

	// ── COACH pane: a centered thought (top 4 rows) + a bottom-right footer ──
	ctext, ccol := coachLine(st, ctxPct, sprintStart)
	if hcol == GREEN && ccol == AMBER {
		ccol = BRAND // cool/healthy → a reflective nudge, not an alarm (no orange)
	}
	thought := lipgloss.NewStyle().Width(hw).Height(4).Background(BG).Foreground(ccol).
		Align(lipgloss.Center).AlignVertical(lipgloss.Center).Render("▸ " + ctext)
	// presence + sign-off, pinned bottom-right. Counts show only when the brain has
	// fetched them (pres_* on the bus); otherwise just the sign-off — no fake numbers.
	foot := "thanks for using /maxx"
	if pp, pc := int(sf(st, "pres_people")), int(sf(st, "pres_countries")); pp > 0 && pc > 0 {
		foot = fmt.Sprintf("%d maxxing · %d countries · %s", pp, pc, foot)
	}
	footer := lipgloss.NewStyle().Width(hw).Background(BG).Foreground(DIM).
		Align(lipgloss.Right).Render(trunc(foot, hw))
	coachPane := lipgloss.JoinVertical(lipgloss.Left, thought, footer)

	// ── assemble: M │ console │ coach ──
	pane := func(w int) lipgloss.Style {
		return lipgloss.NewStyle().Width(w).Height(5).Background(BG)
	}
	sep := pane(3).Foreground(DIM).Render(strings.Repeat(" │ \n", 4) + " │ ")
	phase := float64(time.Now().Unix()%8) - 4 // shine sweep, advances each tick
	mBlock := pane(mW).Render(strings.Join(mMarkRows(phase), "\n"))

	row := lipgloss.JoinHorizontal(lipgloss.Top,
		mBlock, sep, pane(cw).Render(console), sep, coachPane,
	)

	panel := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(hsl(270, 0.5, 0.42)).
		BorderBackground(BG).
		Background(BG).
		Padding(0, 1).
		Render(row)

	fmt.Println(panel)
}

// coachLine: product/build guidance. brain advice (fresh) > your sprint intention >
// new-sprint prompt > context-weight nudge > a gentle ship reminder. No token tips —
// the vibe coder wants "what should I build/ship next", not "warm your cache".
func coachLine(st map[string]any, ctxPct, sprintStart float64) (string, lipgloss.Color) {
	adv, advTs := ss(st, "advice"), sf(st, "advice_ts")
	// advice_ts is written by the brain in ms (Date.now()); compare in ms so a stale
	// thought actually expires (~5 min) instead of lingering forever.
	if adv != "" && float64(time.Now().UnixMilli())-advTs < 300_000 {
		return adv, AMBER
	}
	intent, intentStart := ss(st, "intent"), sf(st, "intent_start")
	if intent != "" && math.Abs(intentStart-sprintStart) < 1 {
		return "→ " + intent, BRAND
	}
	now := float64(time.Now().Unix())
	if now-sprintStart > 0 && now-sprintStart < 180 && intent == "" {
		return "new sprint — what are you shipping?", AMBER
	}
	if ctxPct >= 75 {
		return "context heavy — commit at a clean stop, then /compact", AMBER
	}
	return "running clean — ship the smallest thing that works", GREEN
}
