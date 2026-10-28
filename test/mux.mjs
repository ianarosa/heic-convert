import fs from 'node:fs';
const raw = fs.readFileSync(process.argv[2]);

// --- parse Annex B NAL units (3- or 4-byte start codes)
const starts = [];
for (let i = 0; i + 3 < raw.length; i++) {
  if (raw[i] === 0 && raw[i+1] === 0 && raw[i+2] === 1) starts.push({ at: i, len: 3 });
  else if (raw[i] === 0 && raw[i+1] === 0 && raw[i+2] === 0 && raw[i+3] === 1) { starts.push({ at: i, len: 4 }); i++; }
}
const nals = starts.map((s, k) => {
  const b = s.at + s.len;
  const e = k + 1 < starts.length ? starts[k+1].at : raw.length;
  return { type: (raw[b] >> 1) & 0x3f, data: raw.subarray(b, e) };
});
console.log('NALs:', nals.map(n => `${n.type}(${n.data.length}B)`).join(' '));

const vps = nals.find(n => n.type === 32), sps = nals.find(n => n.type === 33), pps = nals.find(n => n.type === 34);
const slices = nals.filter(n => n.type <= 31);
if (!vps || !sps || !pps || !slices.length) { console.error('MISSING NALs'); process.exit(1); }

const u8 = (...v) => Buffer.from(v);
const u16 = v => { const b = Buffer.alloc(2); b.writeUInt16BE(v); return b; };
const u32 = v => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };
const box = (type, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([u32(body.length + 8), Buffer.from(type, 'ascii'), body]); };
const fullbox = (type, ver, flags, ...parts) => box(type, u8(ver, (flags>>16)&255, (flags>>8)&255, flags&255), ...parts);

// --- width/height from the encode (we know it: 64x64)
const W = Number(process.argv[3] || 64), H = Number(process.argv[4] || 64);
const ITEM_ID = 1;

// hvcC (ISO/IEC 14496-15). Copy profile bytes straight out of SPS payload.
// SPS layout after 2-byte NAL hdr: sps_video_parameter_set_id(4b) max_sub_layers_minus1(3b) temporal_id_nesting(1b) then profile_tier_level (12 bytes for general).
const s = sps.data;
const ptl = s.subarray(2 + 1, 2 + 1 + 12); // general_profile_space..general_level_idc
const generalProfileSpaceTierIdc = ptl[0];
const generalProfileCompat = ptl.subarray(1, 5);
const generalConstraint = ptl.subarray(5, 11);
const generalLevelIdc = ptl[11];

const arr = (type, nal) => Buffer.concat([
  u8(0x80 | type),         // array_completeness=1, reserved=0, NAL_unit_type
  u16(1),                  // numNalus
  u16(nal.data.length), nal.data,
]);
const hvcC = box('hvcC', Buffer.concat([
  u8(1),                                  // configurationVersion
  u8(generalProfileSpaceTierIdc),
  generalProfileCompat,
  generalConstraint,
  u8(generalLevelIdc),
  u16(0xf000),                            // reserved(4b)=1111 + min_spatial_segmentation_idc=0
  u8(0xfc),                               // reserved + parallelismType=0
  u8(0xfc | 1),                           // reserved + chromaFormat=1 (4:2:0)
  u8(0xf8),                               // reserved + bitDepthLumaMinus8=0
  u8(0xf8),                               // reserved + bitDepthChromaMinus8=0
  u16(0),                                 // avgFrameRate
  u8((0 << 6) | (0 << 3) | (0 << 2) | 3), // constantFrameRate/numTemporalLayers/temporalIdNested/lengthSizeMinusOne=3
  u8(3),                                  // numOfArrays
  arr(32, vps), arr(33, sps), arr(34, pps),
]));

const ispe = fullbox('ispe', 0, 0, u32(W), u32(H));
const ipco = box('ipco', hvcC, ispe);
// ipma: one entry, item 1, 2 associations (hvcC essential, ispe non-essential)
const ipma = fullbox('ipma', 0, 0, u32(1), u16(ITEM_ID), u8(2), u8(0x80 | 1), u8(0x00 | 2));
const iprp = box('iprp', ipco, ipma);

// mdat payload = length-prefixed NAL units (lengthSize=4)
const mdat = Buffer.concat(slices.map(n => Buffer.concat([u32(n.data.length), n.data])));

const hdlr = fullbox('hdlr', 0, 0, u32(0), Buffer.from('pict', 'ascii'), u32(0), u32(0), u32(0), u8(0));
const pitm = fullbox('pitm', 0, 0, u16(ITEM_ID));
const infe = fullbox('infe', 2, 0, u16(ITEM_ID), u16(0), Buffer.from('hvc1', 'ascii'), Buffer.from('\0', 'ascii'));
const iinf = fullbox('iinf', 0, 0, u16(1), infe);

// iloc version 1, offset_size=4 length_size=4 base_offset_size=0 index_size=0
const mkIloc = off => fullbox('iloc', 1, 0,
  u8(0x44), u8(0x00), u16(1),
  u16(ITEM_ID), u16(0), u16(0), u16(1), u32(off), u32(mdat.length));

// two-pass: iloc offset depends on meta size which depends on iloc (fixed size), so resolve
let meta = fullbox('meta', 0, 0, hdlr, pitm, iinf, iprp, mkIloc(0));
const ftyp = box('ftyp', Buffer.from('heic', 'ascii'), u32(0), Buffer.concat([Buffer.from('mif1', 'ascii'), Buffer.from('heic', 'ascii')]));
const mdatOffset = ftyp.length + meta.length + 8; // +8 = mdat header
meta = fullbox('meta', 0, 0, hdlr, pitm, iinf, iprp, mkIloc(mdatOffset));

const out = Buffer.concat([ftyp, meta, box('mdat', mdat)]);
fs.writeFileSync(process.argv[5] || 'tiny.heic', out);
console.log('wrote', process.argv[5] || 'tiny.heic', out.length, 'bytes; mdatOffset=', mdatOffset);
