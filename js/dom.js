// dom.js
// Depends on: (none — reads DOM only)

/* ═══════════════════════════════════════════════════════════════════
   3. CACHED DOM REFERENCES
   ═══════════════════════════════════════════════════════════════════ */

const $header      = document.querySelector('header');
const $playbackBar = document.getElementById('playbackBar');
const $navBackBtn  = document.getElementById('navBackBtn');
const $navFwdBtn   = document.getElementById('navForwardBtn');
const $pipeline    = document.querySelector('.hqplayer-audio-pipeline');
const $hqBtn       = document.getElementById('hqplayerBtn');
const $pbRight     = document.querySelector('.pb-right');
const $volBtn      = document.getElementById('pbVolumeBtn');
const $volIcon     = document.getElementById('volIcon');
const $progress    = document.getElementById('pbProgress');
const $pbTitle     = document.getElementById('pbTitle');
const $pbArtist    = document.getElementById('pbArtist');
const $pbImg       = document.getElementById('pbImg');
const $playPause   = document.getElementById('playPauseIcon');
const $pbPlayPauseBtn = document.getElementById('pbPlayPauseBtn');
const $pbTimeCur   = document.getElementById('pbTimeCurrent');
const $pbTimeTot   = document.getElementById('pbTimeTotal');
const $pbTimeCurMin = $pbTimeCur.querySelector('.pb-time-min');
const $pbTimeCurSec = $pbTimeCur.querySelector('.pb-time-sec');
const $shuffleBtn  = document.getElementById('shuffleBtn');
const $repeatBtn   = document.getElementById('repeatBtn');
const $prevBtn     = document.getElementById('prevBtn');
const $nextBtn     = document.getElementById('nextBtn');
const $stats       = document.getElementById('stats');
const $sortBtn     = document.getElementById('sortBtn');
const $headerInfo  = document.getElementById('headerAlbumInfo');
const $headerTitle = document.getElementById('headerAlbumTitle');
const $headerArtist= document.getElementById('headerAlbumArtist');
const $gridView    = document.getElementById('gridView');
const $detailView  = document.getElementById('albumDetailView');
const $detailContent = document.getElementById('albumDetailContent');
const $queueView    = document.getElementById('queueView');
const $queueContent = document.getElementById('queueContent');
const $content     = document.getElementById('content');
const $volDbText   = document.getElementById('volDbText');
const $pbInfo      = document.getElementById('pbInfo');
const $waveform    = document.getElementById('pbWaveform');

// Dynamic reference — reassigned every time a new album detail is rendered
let $detailArtist = null;