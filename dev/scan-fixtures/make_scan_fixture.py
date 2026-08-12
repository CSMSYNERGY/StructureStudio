#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Synthetic LiDAR-scan stand-ins for the StructureStudio scan pipeline.

Spec-valid binary glTF 2.0, standard library ONLY.  Shed declared in FEET,
emitted in METRES, Y-up, on y=0, centred in X/Z, zero roof overhang so the
bbox IS the footprint.  12x8 ft footprint, 6.5 ft eave, 9 ft peak; the gable
ridge runs along X so the roof planes face +Z/-Z (pitch 7.5:12, 32.005 deg).

Variants: A shed alone; B shed + 30 ft ground plane fused into the same
primitive (bbox 30x30 > building); C shed under a node translation (5,0,-3) m
plus 30 deg Y rotation (accessor min/max alone gives the wrong answer);
D the same shed with a 1 ft roof overhang on every side (footprint and eave
must come from the WALLS, not the sweep box); E a 12x8 gambrel barn (knee at
+/-2 ft, knee y 9.5 ft, peak 10.5 ft: lower pitch 1.5, upper 0.5); F a
mono-pitch shed (low wall 6.5 ft, high wall 8.5 ft: rise 2 ft over the full
8 ft depth = renderer shed pitch 0.25); G variant D as seeded noisy triangle
soup with a bumpy ground, a 6 ft fence 1.5 m off one wall and a truck-sized
box 2 m off another - the component isolation must drop both.

    python make_scan_fixture.py [--write] [--verify] [--html] [--outdir D]
"""

import argparse
import base64
import json
import math
import os
import random
import struct
import sys

# --------------------------------------------------------------------------
# units
# --------------------------------------------------------------------------
FOOT = 0.3048                      # exact, by international definition


def ft2m(v):
    return v * FOOT


def m2ft(v):
    return v / FOOT


def f32(x):
    """Round a Python float through IEEE-754 binary32.

    Everything that lands in the BIN chunk is a float32, so the accessor
    min/max we advertise in the JSON must be the *rounded* values or the
    Khronos validator raises ACCESSOR_MIN_MISMATCH / ACCESSOR_MAX_MISMATCH.
    """
    return struct.unpack('<f', struct.pack('<f', float(x)))[0]


# --------------------------------------------------------------------------
# design constants, in FEET
# --------------------------------------------------------------------------
WIDTH_FT = 12.0     # X, the long axis; the ridge runs along it
DEPTH_FT = 8.0      # Z
EAVE_FT = 6.5       # top of wall
PEAK_FT = 9.0       # ridge
GROUND_FT = 30.0    # square ground plane, variant B

HW = ft2m(WIDTH_FT) / 2.0      # 1.8288
HD = ft2m(DEPTH_FT) / 2.0      # 1.2192
EAVE = ft2m(EAVE_FT)           # 1.9812
PEAK = ft2m(PEAK_FT)           # 2.7432
HG = ft2m(GROUND_FT) / 2.0     # 4.572


# --------------------------------------------------------------------------
# tiny vector helpers
# --------------------------------------------------------------------------
def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def cross(u, v):
    return (u[1] * v[2] - u[2] * v[1],
            u[2] * v[0] - u[0] * v[2],
            u[0] * v[1] - u[1] * v[0])


def dot(u, v):
    return u[0] * v[0] + u[1] * v[1] + u[2] * v[2]


def normalize(v):
    n = math.sqrt(dot(v, v))
    if n == 0.0:
        raise ValueError('zero-length normal')
    return (v[0] / n, v[1] / n, v[2] / n)


# --------------------------------------------------------------------------
# mesh builder -- flat shaded, so every face owns its vertices
# --------------------------------------------------------------------------
class MeshBuilder(object):
    def __init__(self):
        self.pos = []
        self.nrm = []
        self.idx = []

    def add_poly(self, verts, outward):
        """Append a convex polygon.

        `verts` must be wound counter-clockwise as seen from OUTSIDE the solid
        (glTF's default front face).  `outward` is the intended outward
        direction; we assert the winding actually produces it rather than
        trusting that the coordinates were typed correctly.
        """
        if len(verts) < 3:
            raise ValueError('need >= 3 vertices')
        geo = cross(sub(verts[1], verts[0]), sub(verts[2], verts[0]))
        if dot(geo, outward) <= 0.0:
            raise ValueError('winding disagrees with outward normal %r' % (outward,))
        n = normalize(geo)
        base = len(self.pos)
        for v in verts:
            self.pos.append(v)
            self.nrm.append(n)
        for k in range(1, len(verts) - 1):        # fan triangulation
            self.idx.extend([base, base + k, base + k + 1])

    def add_tri_raw(self, a, b, c):
        """Append one triangle without the winding assert.

        The noisy variant jitters vertices, which can flip a near-degenerate
        winding; the material is doubleSided, so orientation is cosmetic
        there. Degenerate (zero-area) triangles are skipped.
        """
        geo = cross(sub(b, a), sub(c, a))
        if dot(geo, geo) < 1e-18:
            return
        n = normalize(geo)
        base = len(self.pos)
        for v in (a, b, c):
            self.pos.append(v)
            self.nrm.append(n)
        self.idx.extend([base, base + 1, base + 2])

    def counts(self):
        return len(self.pos), len(self.idx) // 3


def build_shed(mb, ov_ft=0.0):
    """The 12x8 shed: 5 box faces + 2 gable triangles + 2 roof planes.

    `ov_ft` extends the roof planes past the walls on every side (the plane
    keeps its slope, so the outer edge drops below the eave). Zero adds 0.0
    to every coordinate, so the original variants stay byte-identical.
    """
    ov = ft2m(ov_ft)
    pitch = (PEAK - EAVE) / HD
    y_edge = EAVE - ov * pitch
    # floor (y=0), outward = down
    mb.add_poly([(-HW, 0.0, -HD), (HW, 0.0, -HD), (HW, 0.0, HD), (-HW, 0.0, HD)],
                (0.0, -1.0, 0.0))
    # +Z wall
    mb.add_poly([(-HW, 0.0, HD), (HW, 0.0, HD), (HW, EAVE, HD), (-HW, EAVE, HD)],
                (0.0, 0.0, 1.0))
    # -Z wall
    mb.add_poly([(HW, 0.0, -HD), (-HW, 0.0, -HD), (-HW, EAVE, -HD), (HW, EAVE, -HD)],
                (0.0, 0.0, -1.0))
    # +X wall
    mb.add_poly([(HW, 0.0, HD), (HW, 0.0, -HD), (HW, EAVE, -HD), (HW, EAVE, HD)],
                (1.0, 0.0, 0.0))
    # -X wall
    mb.add_poly([(-HW, 0.0, -HD), (-HW, 0.0, HD), (-HW, EAVE, HD), (-HW, EAVE, -HD)],
                (-1.0, 0.0, 0.0))
    # +X gable triangle
    mb.add_poly([(HW, EAVE, HD), (HW, EAVE, -HD), (HW, PEAK, 0.0)],
                (1.0, 0.0, 0.0))
    # -X gable triangle
    mb.add_poly([(-HW, EAVE, -HD), (-HW, EAVE, HD), (-HW, PEAK, 0.0)],
                (-1.0, 0.0, 0.0))
    # +Z roof plane (outer edge at z=+HD+ov down at y_edge, up to the ridge)
    mb.add_poly([(-HW - ov, y_edge, HD + ov), (HW + ov, y_edge, HD + ov),
                 (HW + ov, PEAK, 0.0), (-HW - ov, PEAK, 0.0)],
                (0.0, 1.0, 1.0))
    # -Z roof plane
    mb.add_poly([(HW + ov, y_edge, -HD - ov), (-HW - ov, y_edge, -HD - ov),
                 (-HW - ov, PEAK, 0.0), (HW + ov, PEAK, 0.0)],
                (0.0, 1.0, -1.0))


# gambrel profile, in FEET then metres: knee at +/-2 ft, knee y 9.5, peak 10.5
G_KZ = ft2m(2.0)
G_KNEE_Y = ft2m(9.5)
G_PEAK = ft2m(10.5)


def build_gambrel(mb):
    """A 12x8 gambrel barn: box walls, pentagon ends, four roof planes.

    Lower pitch (9.5-6.5)/(4-2) = 1.5, upper (10.5-9.5)/2 = 0.5 - a 3x slope
    ratio the two-segment fit must find. Zero overhang keeps it exact.
    """
    # floor + four walls to the eave (same as the shed body)
    mb.add_poly([(-HW, 0.0, -HD), (HW, 0.0, -HD), (HW, 0.0, HD), (-HW, 0.0, HD)],
                (0.0, -1.0, 0.0))
    mb.add_poly([(-HW, 0.0, HD), (HW, 0.0, HD), (HW, EAVE, HD), (-HW, EAVE, HD)],
                (0.0, 0.0, 1.0))
    mb.add_poly([(HW, 0.0, -HD), (-HW, 0.0, -HD), (-HW, EAVE, -HD), (HW, EAVE, -HD)],
                (0.0, 0.0, -1.0))
    mb.add_poly([(HW, 0.0, HD), (HW, 0.0, -HD), (HW, EAVE, -HD), (HW, EAVE, HD)],
                (1.0, 0.0, 0.0))
    mb.add_poly([(-HW, 0.0, -HD), (-HW, 0.0, HD), (-HW, EAVE, HD), (-HW, EAVE, -HD)],
                (-1.0, 0.0, 0.0))
    # +X pentagon end (CCW seen from +X)
    mb.add_poly([(HW, EAVE, HD), (HW, EAVE, -HD), (HW, G_KNEE_Y, -G_KZ),
                 (HW, G_PEAK, 0.0), (HW, G_KNEE_Y, G_KZ)],
                (1.0, 0.0, 0.0))
    # -X pentagon end
    mb.add_poly([(-HW, EAVE, -HD), (-HW, EAVE, HD), (-HW, G_KNEE_Y, G_KZ),
                 (-HW, G_PEAK, 0.0), (-HW, G_KNEE_Y, -G_KZ)],
                (-1.0, 0.0, 0.0))
    # +Z lower roof plane (steep)
    mb.add_poly([(-HW, EAVE, HD), (HW, EAVE, HD), (HW, G_KNEE_Y, G_KZ), (-HW, G_KNEE_Y, G_KZ)],
                (0.0, HD - G_KZ, G_KNEE_Y - EAVE))
    # +Z upper roof plane (shallow)
    mb.add_poly([(-HW, G_KNEE_Y, G_KZ), (HW, G_KNEE_Y, G_KZ), (HW, G_PEAK, 0.0), (-HW, G_PEAK, 0.0)],
                (0.0, G_KZ, G_PEAK - G_KNEE_Y))
    # -Z lower roof plane
    mb.add_poly([(HW, EAVE, -HD), (-HW, EAVE, -HD), (-HW, G_KNEE_Y, -G_KZ), (HW, G_KNEE_Y, -G_KZ)],
                (0.0, HD - G_KZ, -(G_KNEE_Y - EAVE)))
    # -Z upper roof plane
    mb.add_poly([(HW, G_KNEE_Y, -G_KZ), (-HW, G_KNEE_Y, -G_KZ), (-HW, G_PEAK, 0.0), (HW, G_PEAK, 0.0)],
                (0.0, G_KZ, -(G_PEAK - G_KNEE_Y)))


# mono-pitch shed: low wall 6.5 ft at +Z, high wall 8.5 ft at -Z
M_HIGH = ft2m(8.5)


def build_mono(mb):
    """A 12x8 mono-pitch (single-slope) shed: rise 2 ft over the 8 ft depth,
    i.e. the renderer's shed pitch 0.25. The across-midpoint drifts at half
    the taper rate, which is the shed signature the classifier reads."""
    mb.add_poly([(-HW, 0.0, -HD), (HW, 0.0, -HD), (HW, 0.0, HD), (-HW, 0.0, HD)],
                (0.0, -1.0, 0.0))
    # +Z (low) wall
    mb.add_poly([(-HW, 0.0, HD), (HW, 0.0, HD), (HW, EAVE, HD), (-HW, EAVE, HD)],
                (0.0, 0.0, 1.0))
    # -Z (high) wall
    mb.add_poly([(HW, 0.0, -HD), (-HW, 0.0, -HD), (-HW, M_HIGH, -HD), (HW, M_HIGH, -HD)],
                (0.0, 0.0, -1.0))
    # +X trapezoid wall
    mb.add_poly([(HW, 0.0, HD), (HW, 0.0, -HD), (HW, M_HIGH, -HD), (HW, EAVE, HD)],
                (1.0, 0.0, 0.0))
    # -X trapezoid wall
    mb.add_poly([(-HW, 0.0, -HD), (-HW, 0.0, HD), (-HW, EAVE, HD), (-HW, M_HIGH, -HD)],
                (-1.0, 0.0, 0.0))
    # single roof plane, low edge at +Z
    mb.add_poly([(-HW, EAVE, HD), (HW, EAVE, HD), (HW, M_HIGH, -HD), (-HW, M_HIGH, -HD)],
                (0.0, 1.0, 0.3))


def _jit(v, rng, amp):
    return (v[0] + rng.uniform(-amp, amp),
            v[1] + rng.uniform(-amp, amp),
            v[2] + rng.uniform(-amp, amp))


def _soup_quad(mb, rng, a, b, c, d, step, amp):
    """Subdivide quad a-b-c-d (a->b is one edge direction, a->d the other)
    into ~`step`-sized cells and emit jittered raw triangles."""
    ab = sub(b, a)
    ad = sub(d, a)
    nu = max(1, int(math.ceil(math.sqrt(dot(ab, ab)) / step)))
    nv = max(1, int(math.ceil(math.sqrt(dot(ad, ad)) / step)))
    def at(iu, iv):
        fu = iu / float(nu)
        fv = iv / float(nv)
        return (a[0] + ab[0] * fu + ad[0] * fv,
                a[1] + ab[1] * fu + ad[1] * fv,
                a[2] + ab[2] * fu + ad[2] * fv)
    for iu in range(nu):
        for iv in range(nv):
            p00 = _jit(at(iu, iv), rng, amp)
            p10 = _jit(at(iu + 1, iv), rng, amp)
            p11 = _jit(at(iu + 1, iv + 1), rng, amp)
            p01 = _jit(at(iu, iv + 1), rng, amp)
            mb.add_tri_raw(p00, p10, p11)
            mb.add_tri_raw(p00, p11, p01)


def build_noisy(mb, rng):
    """Variant D as scan-like triangle soup: every surface subdivided to
    ~15 cm and jittered +/-1.5 cm, on a 30 ft bumpy ground (+/-4 cm), with a
    6 ft fence panel 1.5 m off the +Z wall and a truck-sized box 2 m off the
    -X wall. Ground bumps stay under the waist; the isolation must drop the
    fence and the truck."""
    STEP = 0.15
    AMP = 0.015
    ov = ft2m(1.0)
    pitch = (PEAK - EAVE) / HD
    y_edge = EAVE - ov * pitch
    # shed walls
    _soup_quad(mb, rng, (-HW, 0.0, HD), (HW, 0.0, HD), (HW, EAVE, HD), (-HW, EAVE, HD), STEP, AMP)
    _soup_quad(mb, rng, (HW, 0.0, -HD), (-HW, 0.0, -HD), (-HW, EAVE, -HD), (HW, EAVE, -HD), STEP, AMP)
    _soup_quad(mb, rng, (HW, 0.0, HD), (HW, 0.0, -HD), (HW, EAVE, -HD), (HW, EAVE, HD), STEP, AMP)
    _soup_quad(mb, rng, (-HW, 0.0, -HD), (-HW, 0.0, HD), (-HW, EAVE, HD), (-HW, EAVE, -HD), STEP, AMP)
    # gable triangles (raw, lightly jittered corners)
    mb.add_tri_raw(_jit((HW, EAVE, HD), rng, AMP), _jit((HW, EAVE, -HD), rng, AMP), _jit((HW, PEAK, 0.0), rng, AMP))
    mb.add_tri_raw(_jit((-HW, EAVE, -HD), rng, AMP), _jit((-HW, EAVE, HD), rng, AMP), _jit((-HW, PEAK, 0.0), rng, AMP))
    # overhanging roof planes
    _soup_quad(mb, rng, (-HW - ov, y_edge, HD + ov), (HW + ov, y_edge, HD + ov),
               (HW + ov, PEAK, 0.0), (-HW - ov, PEAK, 0.0), STEP, AMP)
    _soup_quad(mb, rng, (HW + ov, y_edge, -HD - ov), (-HW - ov, y_edge, -HD - ov),
               (-HW - ov, PEAK, 0.0), (HW + ov, PEAK, 0.0), STEP, AMP)
    # bumpy ground: 0.5 m cells, +/-4 cm vertical only
    ng = int(math.ceil((2 * HG) / 0.5))
    for iu in range(ng):
        for iv in range(ng):
            def gp(du, dv):
                x = -HG + (iu + du) * (2 * HG / ng)
                z = -HG + (iv + dv) * (2 * HG / ng)
                return (x, rng.uniform(-0.04, 0.04), z)
            p00, p10, p11, p01 = gp(0, 0), gp(1, 0), gp(1, 1), gp(0, 1)
            mb.add_tri_raw(p00, p10, p11)
            mb.add_tri_raw(p00, p11, p01)
    # fence: 10 ft long x 6 ft tall, 1.5 m off the +Z wall
    fz = HD + 1.5
    _soup_quad(mb, rng, (-ft2m(5.0), 0.0, fz), (ft2m(5.0), 0.0, fz),
               (ft2m(5.0), ft2m(6.0), fz), (-ft2m(5.0), ft2m(6.0), fz), STEP, AMP)
    # truck-sized box: 6 ft (X) x 1.6 m (Y) x 4 ft (Z), 2 m off the -X wall
    tx1 = -HW - 2.0
    tx0 = tx1 - ft2m(6.0)
    tz = ft2m(2.0)
    _soup_quad(mb, rng, (tx0, 0.0, tz), (tx1, 0.0, tz), (tx1, 1.6, tz), (tx0, 1.6, tz), STEP, AMP)
    _soup_quad(mb, rng, (tx1, 0.0, -tz), (tx0, 0.0, -tz), (tx0, 1.6, -tz), (tx1, 1.6, -tz), STEP, AMP)
    _soup_quad(mb, rng, (tx0, 1.6, tz), (tx1, 1.6, tz), (tx1, 1.6, -tz), (tx0, 1.6, -tz), STEP, AMP)


def build_ground(mb):
    """A 30 ft square slab at y=0, facing up."""
    mb.add_poly([(-HG, 0.0, -HG), (-HG, 0.0, HG), (HG, 0.0, HG), (HG, 0.0, -HG)],
                (0.0, 1.0, 0.0))


# --------------------------------------------------------------------------
# GLB writer
# --------------------------------------------------------------------------
GLB_MAGIC = 0x46546C67          # 'glTF'
CHUNK_JSON = 0x4E4F534A         # 'JSON'
CHUNK_BIN = 0x004E4942          # 'BIN\0'

COMP_USHORT = 5123
COMP_FLOAT = 5126
TARGET_ARRAY = 34962            # ARRAY_BUFFER
TARGET_ELEMENT = 34963          # ELEMENT_ARRAY_BUFFER
MODE_TRIANGLES = 4


def _pad4(buf, fill):
    r = len(buf) % 4
    return buf if r == 0 else buf + fill * (4 - r)


def build_glb(mb, mesh_name, node_name, node_props=None, generator=None):
    """Serialise a MeshBuilder to GLB bytes.

    BIN layout (a single buffer, three tightly packed bufferViews):
        [0                      ) POSITION   float32 x3, 12 B/vertex
        [len(pos)               ) NORMAL     float32 x3, 12 B/vertex
        [len(pos)+len(nrm)      ) indices    uint16,      2 B/index
        then zero padding to a 4-byte boundary.
    POSITION/NORMAL are 12 B/element so their offsets are inherently 4- and
    12-aligned; the index view starts at a multiple of 12 and is therefore
    2-aligned (glTF requires accessor byteOffset+bufferView byteOffset to be a
    multiple of the component size) and 4-aligned (required for GLB chunks).
    """
    nverts, ntris = mb.counts()
    if nverts > 0xFFFF:
        raise ValueError('too many vertices for UNSIGNED_SHORT indices')

    pos_bytes = b''.join(struct.pack('<3f', *p) for p in mb.pos)
    nrm_bytes = b''.join(struct.pack('<3f', *n) for n in mb.nrm)
    idx_bytes = b''.join(struct.pack('<H', i) for i in mb.idx)

    off_pos = 0
    off_nrm = off_pos + len(pos_bytes)
    off_idx = off_nrm + len(nrm_bytes)
    for name, off, comp in (('POSITION', off_pos, 4), ('NORMAL', off_nrm, 4),
                            ('indices', off_idx, 2)):
        if off % comp:
            raise AssertionError('%s offset %d not %d-aligned' % (name, off, comp))
    if off_idx % 4:
        raise AssertionError('index bufferView offset %d not 4-aligned' % off_idx)

    bin_chunk = _pad4(pos_bytes + nrm_bytes + idx_bytes, b'\x00')

    # accessor min/max from the float32 values that are actually in the buffer
    px = [f32(p[0]) for p in mb.pos]
    py = [f32(p[1]) for p in mb.pos]
    pz = [f32(p[2]) for p in mb.pos]
    pos_min = [min(px), min(py), min(pz)]
    pos_max = [max(px), max(py), max(pz)]

    node = {'mesh': 0, 'name': node_name}
    if node_props:
        node.update(node_props)

    gltf = {
        'asset': {
            'version': '2.0',
            'generator': generator or 'StructureStudio make_scan_fixture.py (stdlib)',
        },
        'scene': 0,
        'scenes': [{'name': 'scan', 'nodes': [0]}],
        'nodes': [node],
        'meshes': [{
            'name': mesh_name,
            'primitives': [{
                'attributes': {'POSITION': 0, 'NORMAL': 1},
                'indices': 2,
                'material': 0,
                'mode': MODE_TRIANGLES,
            }],
        }],
        'materials': [{
            'name': 'scan_surface',
            'doubleSided': True,
            'pbrMetallicRoughness': {
                'baseColorFactor': [0.72, 0.70, 0.66, 1.0],
                'metallicFactor': 0.0,
                'roughnessFactor': 0.9,
            },
        }],
        'accessors': [
            {'bufferView': 0, 'componentType': COMP_FLOAT, 'count': nverts,
             'type': 'VEC3', 'min': pos_min, 'max': pos_max},
            {'bufferView': 1, 'componentType': COMP_FLOAT, 'count': nverts,
             'type': 'VEC3'},
            {'bufferView': 2, 'componentType': COMP_USHORT, 'count': len(mb.idx),
             'type': 'SCALAR'},
        ],
        'bufferViews': [
            {'buffer': 0, 'byteOffset': off_pos, 'byteLength': len(pos_bytes),
             'target': TARGET_ARRAY},
            {'buffer': 0, 'byteOffset': off_nrm, 'byteLength': len(nrm_bytes),
             'target': TARGET_ARRAY},
            {'buffer': 0, 'byteOffset': off_idx, 'byteLength': len(idx_bytes),
             'target': TARGET_ELEMENT},
        ],
        # no 'uri': buffer 0 IS the GLB BIN chunk
        'buffers': [{'byteLength': len(bin_chunk)}],
    }

    json_chunk = _pad4(json.dumps(gltf, separators=(',', ':'),
                                  sort_keys=True).encode('utf-8'), b'\x20')

    total = 12 + 8 + len(json_chunk) + 8 + len(bin_chunk)
    out = bytearray()
    out += struct.pack('<III', GLB_MAGIC, 2, total)
    out += struct.pack('<II', len(json_chunk), CHUNK_JSON)
    out += json_chunk
    out += struct.pack('<II', len(bin_chunk), CHUNK_BIN)
    out += bin_chunk
    if len(out) != total:
        raise AssertionError('declared %d != actual %d' % (total, len(out)))
    if len(out) % 4:
        raise AssertionError('GLB length %d not 4-aligned' % len(out))

    layout = {
        'header': (0, 12), 'json_chunk_header': (12, 8),
        'json_chunk': (20, len(json_chunk)),
        'bin_chunk_header': (20 + len(json_chunk), 8),
        'bin_chunk': (28 + len(json_chunk), len(bin_chunk)),
        'bin_POSITION': (off_pos, len(pos_bytes)),
        'bin_NORMAL': (off_nrm, len(nrm_bytes)),
        'bin_indices': (off_idx, len(idx_bytes)),
        'vertices': nverts, 'triangles': ntris,
    }
    return bytes(out), layout


# --------------------------------------------------------------------------
# variants
# --------------------------------------------------------------------------
def quat_y(deg):
    """xyzw quaternion for a rotation of `deg` about +Y."""
    h = math.radians(deg) / 2.0
    return [0.0, math.sin(h), 0.0, math.cos(h)]


def variants():
    a = MeshBuilder()
    build_shed(a)

    b = MeshBuilder()
    build_shed(b)
    build_ground(b)

    c = MeshBuilder()
    build_shed(c)

    d = MeshBuilder()
    build_shed(d, ov_ft=1.0)

    e = MeshBuilder()
    build_gambrel(e)

    f = MeshBuilder()
    build_mono(f)

    g = MeshBuilder()
    build_noisy(g, random.Random(20260812))

    return [
        ('shed_12x8_gable.glb', a, 'shed', 'shed_node', None,
         'A: shed alone, world bbox == building'),
        ('shed_12x8_gable_ground.glb', b, 'shed_and_ground', 'scan_node', None,
         'B: shed + 30 ft ground plane fused into one primitive'),
        ('shed_12x8_gable_offset_rot.glb', c, 'shed', 'shed_node_placed',
         {'translation': [5.0, 0.0, -3.0], 'rotation': quat_y(30.0)},
         'C: shed offset (5,0,-3) m and rotated 30 deg about Y'),
        ('shed_12x8_gable_ov1.glb', d, 'shed_ov', 'shed_ov_node', None,
         'D: shed with a 1 ft roof overhang on every side'),
        ('barn_12x8_gambrel.glb', e, 'barn', 'barn_node', None,
         'E: gambrel barn, knee +/-2 ft at 9.5 ft, peak 10.5 ft'),
        ('shed_12x8_mono.glb', f, 'mono', 'mono_node', None,
         'F: mono-pitch shed, walls 6.5/8.5 ft (shed pitch 0.25)'),
        ('scanlike_12x8_noisy.glb', g, 'noisy', 'noisy_node', None,
         'G: D as seeded noisy soup + bumpy ground + fence + truck'),
    ]


# ==========================================================================
#  INDEPENDENT READER
#  Deliberately shares nothing with the writer above except the stdlib: it
#  re-derives everything from the raw bytes, including the node world
#  matrices, and cross-checks the declared accessor min/max against the
#  values it decodes itself.
# ==========================================================================
_NCOMP = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4,
          'MAT2': 4, 'MAT3': 9, 'MAT4': 16}
_CTYPE = {5120: ('b', 1), 5121: ('B', 1), 5122: ('h', 2),
          5123: ('H', 2), 5125: ('I', 4), 5126: ('f', 4)}


def mat_identity():
    return [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0]


def mat_mul(a, b):
    """Column-major 4x4 multiply, returning a*b (a applied after b)."""
    out = [0.0] * 16
    for c in range(4):
        for r in range(4):
            s = 0.0
            for k in range(4):
                s += a[k * 4 + r] * b[c * 4 + k]
            out[c * 4 + r] = s
    return out


def mat_from_trs(t, q, s):
    x, y, z, w = q
    xx, yy, zz = x * x, y * y, z * z
    xy, xz, yz = x * y, x * z, y * z
    wx, wy, wz = w * x, w * y, w * z
    m = [
        (1 - 2 * (yy + zz)) * s[0], (2 * (xy + wz)) * s[0], (2 * (xz - wy)) * s[0], 0.0,
        (2 * (xy - wz)) * s[1], (1 - 2 * (xx + zz)) * s[1], (2 * (yz + wx)) * s[1], 0.0,
        (2 * (xz + wy)) * s[2], (2 * (yz - wx)) * s[2], (1 - 2 * (xx + yy)) * s[2], 0.0,
        t[0], t[1], t[2], 1.0,
    ]
    return m


def mat_apply(m, p):
    x, y, z = p
    return (m[0] * x + m[4] * y + m[8] * z + m[12],
            m[1] * x + m[5] * y + m[9] * z + m[13],
            m[2] * x + m[6] * y + m[10] * z + m[14])


def read_glb(path):
    raw = open(path, 'rb').read()
    if len(raw) < 12:
        raise ValueError('too short')
    magic, version, length = struct.unpack_from('<III', raw, 0)
    info = {'file_size': len(raw), 'magic': magic,
            'magic_ascii': struct.pack('<I', magic).decode('ascii', 'replace'),
            'version': version, 'declared_length': length, 'chunks': []}
    off = 12
    js = None
    bindata = b''
    while off + 8 <= len(raw):
        clen, ctype = struct.unpack_from('<II', raw, off)
        off += 8
        body = raw[off:off + clen]
        tag = struct.pack('<I', ctype).decode('ascii', 'replace')
        pad = 0
        if ctype == CHUNK_JSON:
            while body and body[-1:] == b'\x20':
                pad += 1
                body = body[:-1]
            js = json.loads(body.decode('utf-8'))
        elif ctype == CHUNK_BIN:
            bindata = body
            b2 = body
            while b2 and b2[-1:] == b'\x00':
                pad += 1
                b2 = b2[:-1]
        info['chunks'].append({'type_hex': '0x%08X' % ctype, 'type': tag,
                               'length': clen, 'trailing_pad': pad,
                               'len_mod_4': clen % 4})
        off += clen
    if js is None:
        raise ValueError('no JSON chunk')
    info['json'] = js
    info['bin_len'] = len(bindata)
    return info, js, bindata


def read_accessor(js, bindata, i):
    acc = js['accessors'][i]
    ncomp = _NCOMP[acc['type']]
    fmt, csz = _CTYPE[acc['componentType']]
    esz = ncomp * csz
    out = []
    if 'bufferView' not in acc:
        return [tuple([0] * ncomp)] * acc['count']
    bv = js['bufferViews'][acc['bufferView']]
    base = bv.get('byteOffset', 0) + acc.get('byteOffset', 0)
    stride = bv.get('byteStride') or esz
    for k in range(acc['count']):
        o = base + k * stride
        out.append(struct.unpack_from('<' + fmt * ncomp, bindata, o))
    return out


def _walk(js, ni, parent, acc):
    node = js['nodes'][ni]
    if 'matrix' in node:
        local = list(node['matrix'])
    else:
        local = mat_from_trs(node.get('translation', [0, 0, 0]),
                             node.get('rotation', [0, 0, 0, 1]),
                             node.get('scale', [1, 1, 1]))
    world = mat_mul(parent, local)
    acc.append((ni, node.get('name'), node.get('mesh'), world))
    for c in node.get('children', []):
        _walk(js, c, world, acc)


def scene_nodes(js):
    acc = []
    sc = js['scenes'][js.get('scene', 0)]
    for ni in sc.get('nodes', []):
        _walk(js, ni, mat_identity(), acc)
    return acc


def bbox(points):
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    zs = [p[2] for p in points]
    return (min(xs), min(ys), min(zs)), (max(xs), max(ys), max(zs))


def fmt3(v):
    return '[%.6f, %.6f, %.6f]' % tuple(v)


def verify(path):
    print('=' * 78)
    print('VERIFY  %s' % os.path.basename(path))
    print('=' * 78)
    info, js, bindata = read_glb(path)

    print('-- header')
    print('   magic          0x%08X  (%r)  expect 0x46546C67 "glTF"'
          % (info['magic'], info['magic_ascii']))
    print('   version        %d' % info['version'])
    print('   length         %d declared / %d on disk / %% 4 = %d'
          % (info['declared_length'], info['file_size'], info['file_size'] % 4))
    ok_hdr = (info['magic'] == GLB_MAGIC and info['version'] == 2
              and info['declared_length'] == info['file_size'])
    print('   header OK      %s' % ok_hdr)

    print('-- chunks')
    for c in info['chunks']:
        print('   %-6s %s len=%-6d pad=%-2d len%%4=%d'
              % (c['type'].strip('\x00'), c['type_hex'], c['length'],
                 c['trailing_pad'], c['len_mod_4']))
    print('   buffers[0].byteLength %d vs BIN chunk %d'
          % (js['buffers'][0].get('byteLength'), info['bin_len']))
    print('   buffers[0] has uri:   %s (must be False for GLB)'
          % ('uri' in js['buffers'][0]))

    print('-- top level')
    print('   asset %s' % json.dumps(js['asset']))
    print('   keys  %s' % ','.join(sorted(js.keys())))
    print('   nodes=%d meshes=%d accessors=%d bufferViews=%d'
          % (len(js.get('nodes', [])), len(js.get('meshes', [])),
             len(js.get('accessors', [])), len(js.get('bufferViews', []))))

    print('-- bufferViews')
    for i, bv in enumerate(js['bufferViews']):
        o = bv.get('byteOffset', 0)
        print('   [%d] off=%-6d len=%-6d target=%-5s off%%4=%d'
              % (i, o, bv['byteLength'], bv.get('target'), o % 4))

    print('-- accessors (declared min/max vs values decoded from BIN)')
    for i, acc in enumerate(js['accessors']):
        vals = read_accessor(js, bindata, i)
        ncomp = _NCOMP[acc['type']]
        lo = [min(v[c] for v in vals) for c in range(ncomp)]
        hi = [max(v[c] for v in vals) for c in range(ncomp)]
        print('   [%d] %-6s comp=%-4d count=%-4d'
              % (i, acc['type'], acc['componentType'], acc['count']))
        print('        decoded min %s' % ([round(x, 6) for x in lo],))
        print('        decoded max %s' % ([round(x, 6) for x in hi],))
        if 'min' in acc or 'max' in acc:
            dmin = acc.get('min')
            dmax = acc.get('max')
            print('        declared min %s' % ([round(x, 6) for x in dmin],))
            print('        declared max %s' % ([round(x, 6) for x in dmax],))
            match = (all(abs(a - b) < 1e-9 for a, b in zip(dmin, lo))
                     and all(abs(a - b) < 1e-9 for a, b in zip(dmax, hi)))
            print('        MIN/MAX MATCH: %s' % match)
        else:
            print('        (no min/max declared -- optional for non-POSITION)')
        if len(vals) != acc['count']:
            print('        !! count mismatch')

    # ---- world-space geometry
    print('-- scene graph / world-space bbox')
    allpts = []
    for ni, name, mi, world in scene_nodes(js):
        istrs = (abs(world[12]) > 1e-12 or abs(world[13]) > 1e-12
                 or abs(world[14]) > 1e-12
                 or any(abs(world[k] - mat_identity()[k]) > 1e-9 for k in range(12)))
        print('   node[%d] %r mesh=%s  non-identity transform: %s'
              % (ni, name, mi, istrs))
        print('        world matrix cols: %s %s %s %s'
              % (fmt3(world[0:3]), fmt3(world[4:7]),
                 fmt3(world[8:11]), fmt3(world[12:15])))
        if mi is None:
            continue
        for prim in js['meshes'][mi]['primitives']:
            local = read_accessor(js, bindata, prim['attributes']['POSITION'])
            pts = [mat_apply(world, p) for p in local]
            allpts.extend(pts)
            lo, hi = bbox(local)
            print('        primitive local bbox min %s max %s' % (fmt3(lo), fmt3(hi)))
            lo, hi = bbox(pts)
            print('        primitive world bbox min %s max %s' % (fmt3(lo), fmt3(hi)))
            if 'indices' in prim:
                idx = read_accessor(js, bindata, prim['indices'])
                flat = [v[0] for v in idx]
                print('        indices count=%d tris=%d range=%d..%d nverts=%d'
                      % (len(flat), len(flat) // 3, min(flat), max(flat), len(local)))
                if max(flat) >= len(local):
                    print('        !! index out of range')

    lo, hi = bbox(allpts)
    size_m = (hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])
    print('-- SCENE bbox (world, all nodes)')
    print('   min  m  %s' % fmt3(lo))
    print('   max  m  %s' % fmt3(hi))
    print('   size m  X=%.6f Y=%.6f Z=%.6f' % size_m)
    print('   size ft X=%.4f Y=%.4f Z=%.4f'
          % (m2ft(size_m[0]), m2ft(size_m[1]), m2ft(size_m[2])))
    print('   min  ft %s' % fmt3([m2ft(v) for v in lo]))
    print('   max  ft %s' % fmt3([m2ft(v) for v in hi]))
    print('   sits on y=0: %s   (min Y = %.9f m)' % (abs(lo[1]) < 1e-6, lo[1]))

    # ---- horizontal-level diagnostic: what a measurer can recover
    print('-- distinct Y levels (world) with the XZ extent of their vertices')
    lv = {}
    for p in allpts:
        lv.setdefault(round(p[1], 6), []).append(p)
    for y in sorted(lv):
        pts = lv[y]
        xs = [p[0] for p in pts]
        zs = [p[2] for p in pts]
        print('   y=%9.6f m (%7.4f ft)  n=%-3d  X extent %8.4f ft   Z extent %8.4f ft'
              % (y, m2ft(y), len(pts), m2ft(max(xs) - min(xs)),
                 m2ft(max(zs) - min(zs))))
    print()


# --------------------------------------------------------------------------
# optional browser-validation page
# --------------------------------------------------------------------------
HTML = """<!doctype html>
<meta charset="utf-8"><title>GLB fixture check</title>
<pre id="out">loading...</pre>
<script type="module">
import * as THREE from 'https://esm.sh/three@0.167.0';
import { GLTFLoader } from 'https://esm.sh/three@0.167.0/examples/jsm/loaders/GLTFLoader.js';
const FILES = __FILES__;
const FOOT = 0.3048;
const log = [];
const loader = new GLTFLoader();
window.__done = false;
(async () => {
  for (const f of FILES) {
    try {
      const buf = await (await fetch(f)).arrayBuffer();
      const gltf = await loader.parseAsync(buf, '');
      const box = new THREE.Box3().setFromObject(gltf.scene);
      const s = new THREE.Vector3(); box.getSize(s);
      let verts = 0, tris = 0;
      gltf.scene.traverse(o => {
        if (o.isMesh) {
          const g = o.geometry;
          verts += g.attributes.position.count;
          tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
        }
      });
      log.push({ file: f, bytes: buf.byteLength, verts, tris,
        min_m: box.min.toArray(), max_m: box.max.toArray(),
        size_m: s.toArray(),
        size_ft: [s.x / FOOT, s.y / FOOT, s.z / FOOT],
        min_ft: [box.min.x / FOOT, box.min.y / FOOT, box.min.z / FOOT],
        max_ft: [box.max.x / FOOT, box.max.y / FOOT, box.max.z / FOOT],
        generator: gltf.parser.json.asset.generator });
    } catch (e) { log.push({ file: f, error: String(e) }); }
  }
  window.__result = log;
  window.__done = true;
  document.getElementById('out').textContent = JSON.stringify(log, null, 1);
})();
</script>
"""


def write_html(outdir, names):
    p = os.path.join(outdir, 'validate.html')
    with open(p, 'w', encoding='utf-8') as fh:
        fh.write(HTML.replace('__FILES__', json.dumps(names)))
    return p


# --------------------------------------------------------------------------
def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser()
    ap.add_argument('--outdir', default=here)
    ap.add_argument('--write', action='store_true')
    ap.add_argument('--verify', action='store_true')
    ap.add_argument('--html', action='store_true')
    a = ap.parse_args()
    do_write = a.write or not (a.write or a.verify)
    do_verify = a.verify or not (a.write or a.verify)

    os.makedirs(a.outdir, exist_ok=True)
    vs = variants()
    names = [v[0] for v in vs]

    print('design (feet): %g x %g footprint, eave %g, peak %g, ground %g'
          % (WIDTH_FT, DEPTH_FT, EAVE_FT, PEAK_FT, GROUND_FT))
    print('design (m):    %.4f x %.4f, eave %.4f, peak %.4f, ground %.4f'
          % (ft2m(WIDTH_FT), ft2m(DEPTH_FT), EAVE, PEAK, ft2m(GROUND_FT)))
    rise, run = PEAK_FT - EAVE_FT, DEPTH_FT / 2.0
    print('roof pitch:    rise %.2f / run %.2f = %.4f = %.2f:12 = %.3f deg\n'
          % (rise, run, rise / run, rise / run * 12.0,
             math.degrees(math.atan2(rise, run))))

    if do_write:
        for fn, mb, mesh_name, node_name, props, desc in vs:
            data, layout = build_glb(mb, mesh_name, node_name, props)
            p = os.path.join(a.outdir, fn)
            with open(p, 'wb') as fh:
                fh.write(data)
            print('wrote %-34s %6d B   %s' % (fn, len(data), desc))
            print('   layout: %s' % json.dumps(layout, sort_keys=True))
        if a.html:
            print('wrote %s' % write_html(a.outdir, names))
        print()

    if do_verify:
        for fn in names:
            p = os.path.join(a.outdir, fn)
            if os.path.exists(p):
                verify(p)


if __name__ == '__main__':
    main()
