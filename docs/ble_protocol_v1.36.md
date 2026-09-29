# PeriPage A6 / IP-200 V1.36 BLE protocol

Research dated 2026-09-29: a physical printer reporting `V1.36_203dpi`, mobile
application code, and comparison with the
[analyzed V1.22 firmware](ble_protocol_v1.22.md). USB is out of scope.

**The V1.36 image has not been obtained.** This is a specification of observed
behavior on a particular device, not a complete machine-code analysis of this
version. Matching the version number without the model and resolution is
insufficient for selecting a profile. V1.22 commands, RAM addresses, ring buffer
size, and defects must not be automatically carried over.

## 1. Evidence and device profile

This document distinguishes four sources of evidence:

- **Device** — bytes were sent and responses recorded in this session.
- **Paper** — the result was additionally checked in a GoPro photo or by the user.
- **Application** — the command was found in a specific Android application version
  or a public iOS BLE trace; compatibility with this printer still requires testing.
- **V1.22** — a hypothesis based on machine code from a different image.

`No response` below means no **FF01** data within the specified observation window.
**FF03** notifications still arrived. This does not prove that the command is absent
in every mode. `OK=4f 4b`, `AA=aa`; multibyte fields are marked `u16le`, `u16be`,
or `u32be`. Bytes are hexadecimal; other numbers are decimal.

| Property                                  | Observation                                              |
| ----------------------------------------- | -------------------------------------------------------- |
| Family                                    | A6, model response `IP-200`                              |
| Firmware                                  | `V1.36_203dpi`                                           |
| `10 ff 30 10`                             | `v3.38.21_AY`; the application's Bluetooth version field |
| `10 ff 20 ef`                             | `9.05`; exact version meaning unknown                    |
| `180A / 2A28`                             | ASCII `01.1`                                             |
| Advertising                               | Name `PeriPage_…_BLE`, service `FEE7`                    |
| Name response                             | `PeriPage_…`, without `_BLE`                             |
| Profile working width                     | 384 dots, 48 bytes per row; 203 dpi                      |
| CoreBluetooth maximumWriteWithoutResponse | 133 bytes in the measured connection                     |
| Initial FF03                              | `01 04`, followed by `02 64 00`                          |

The complete serial number, MAC, and local CoreBluetooth UUID are retained only
in ignored artifacts. The last is a macOS identifier, not a MAC address.
`v3.38.21_AY` should not be confidently described as the main board/MCU revision:
the application associates it with Bluetooth, and the chip was not physically
identified.

## 2. GATT and connection setup

A short `FFxx` expands to `0000ffxx-0000-1000-8000-00805f9b34fb`.

| UUID   | Device properties             | Purpose                            |
| ------ | ----------------------------- | ---------------------------------- |
| `FF00` | Service                       | Main channel                       |
| `FF01` | Notify                        | Query responses and job events     |
| `FF02` | Write, Write Without Response | Incoming command and raster stream |
| `FF03` | Notify                        | Credits and chunk-size parameter   |

Service `49535343-FE7D-4AE5-8FA9-9FAFD205E455` was also discovered, with notify
`49535343-1E4D-4BD9-BA61-23C647249616` and write
`49535343-8841-43F4-A8D4-ECBE34729BB3`. Its equivalence to FF00 was not tested.
The library must not hardcode ATT handles: characteristics are discovered by UUID.

Client sequence:

1. Find the printer by name; **do not require FF00 in advertising** — this device advertises FEE7.
2. Connect and discover FF00 and its three characteristics.
3. Install handlers and subscribe to FF01/FF03.
4. Account for initial FF03 notifications; the browser startup exception is described below.
5. Send queries/jobs sequentially through FF02 without an ATT response.

In Web Bluetooth, use the filter `namePrefix: 'PeriPage'` with
`optionalServices: [0xff00]`. Call `requestDevice` from a user gesture. An
experimental adapter is in `scripts/firmware/web-bluetooth.ts`; the main hardware
tests used TypeScript → a thin CoreBluetooth bridge.

An additional check of the browser client, `src/lib/peripagejs/client.ts`, on
September 29, 2026 revealed different notification delivery: both subscriptions
completed successfully, but the initial FF03 notifications never reached the
handler. Waiting for a credit before the first write blocked connection setup and
timed out after 10 seconds. The exact layer that lost these notifications is unknown.

Working browser startup: if no initial grant has arrived, send `10 ff fe 01` and
12 zeros once, in a single short FF02 write (16 bytes). FF03 notifications begin
arriving after this write; all subsequent queries and printing use normal credit
accounting. If the initial grant does arrive, initialization also consumes a
credit; an explicit `01 00` is not bypassed. This is a limited connection-startup
exception, not permission to keep sending raster data after a timeout.
Connection and rereading all seven fields were tested on the physical device:
`IP-200`, `V1.36_203dpi`, battery 56%. A later image transfer measurement is
described in section 3.1; it did not confirm physical print quality.

After the mobile test, the printer was temporarily undiscoverable from the Mac.
Disconnecting it in the mobile application restored connectivity. Missing
advertising in this situation must not be interpreted as a wrong UUID or a powered-off
printer.

## 3. Credits and write size

| FF03 payload | Observed value                   | Usage                                                    |
| ------------ | -------------------------------- | -------------------------------------------------------- |
| `01 N`       | Initially `N=4`, then `1` or `2` | Add N FF02 write permissions                             |
| `02 nL nH`   | `64 00` → 100                    | Chunk parameter; the tested profile uses up to 100 bytes |

In CoreBluetooth, the initial grant arrives **on subscription, before `10 ff fe 01`**.
Do not wait until initialization to install the FF03 handler, or credits may be
lost. A write of 1, 4, 48, or 100 bytes consumes one credit. The header, feed, and
end-of-job command use the same accounting. A packet need not match a raster row.
A credit does not mean command completion or physical printing.

Minimal sender model:

```text
new connection: credits = 0
FF03 01 N:      credits += N
FF03 02 lo hi:  printerPacketBytes = lo + 256*hi

before an FF02 write:
    wait for credits > 0 and transport readiness
    size <= min(printerPacketBytes, transportMaximum, requestedChunk)
    credits -= 1
    write using writeWithoutResponse
```

`02 64 00` is not an ATT MTU measurement: CoreBluetooth independently reported a
133-byte limit. The size of 100 must not be assumed for another printer.
Web Bluetooth has no equivalent of `maximumWriteValueLength`. The research adapter
uses 20 bytes. The application has verified writes of up to 100 bytes for the
identified `IP-200 / V1.36_203dpi` profile; this is not an MTU measurement or a
universal limit for other devices or transport implementations.

`01 00` did not occur in the short V1.36 tests. Based on V1.22, the code uses a
conservative policy: a zero grant pauses new writes until a positive grant, with
separate counters retained. This is **client policy**, not experimentally proven
V1.36 semantics. A credit wait timeout is an error, not a reason to send the rest
without limits.

Each research plan creates a new connection and a new counter. Remaining credits
must not carry over between connections. Multiple jobs in one connection and
delayed notifications at their boundaries have not been tested separately.
The V1.36 receive ring buffer's size and thresholds are unknown.

### 3.1. Browser sender performance

When initial FF03 notifications were lost, the previous browser path retained the
20-byte limit and operated only on the credit returned after startup initialization.
For a 384×192 raster (9216 bytes), this meant 461 data writes, waiting for a returned
credit after each write. The unconditional 20-byte cap also prevented use of
`02 64 00` even when that notification arrived.

The corrected sender applies fallback values from repeated captures of this device
**only after identifying the exact profile**: 100 bytes and four initial credits.
If the grant was lost, startup initialization has already consumed one credit, so
only the three unaccounted credits are added. Later grants and subsequent spending
are already accounted for. This fallback is applied once per connection, not on
every job or refresh. If the initial grant arrived, its value is used. A late first
grant greater than one is counted after deducting the startup write and is not
supplemented by the fallback again. A received packet size also takes precedence;
the actual write length is limited to the smaller of that size and 100 bytes.
The four-credit/100-byte fallback is not applied to unknown firmware.

Control browser run on September 29, 2026:

- Image from the page hash: 384×192, 9216 raster bytes.
- Job start: `2026-09-29T13:13:09.059Z`.
- End-marker response `AA` received: `2026-09-29T13:13:12.539Z`.
- Total job time, including feed and waiting for `AA`: **3.480 s**.
- The connection remained open after the job.
- Evidence: `browser-speed-result.json` and `browser-speed-result.png` in
  `storage/firmware/live-v1.36/`. The user chose to check the printout independently;
  there is no photographic confirmation of the image for this experiment.

A regression test simulates each credit returning after 200 ms: the same job
finishes in under six seconds with normal, lost, or delayed initial grants.
It checks 98 total writes and no more than four occupied slots at once, including
an information refresh before printing. Preservation of an explicitly advertised
one-credit window and a smaller packet size was checked separately.

## 4. Command boundaries and responses

Plan `framing`, recording `framing-01`:

| Transmission                           | FF01 result                                             |
| -------------------------------------- | ------------------------------------------------------- |
| `10 ff 20 f1`, in four 1-byte writes   | Complete firmware string                                |
| Same query in 2-byte chunks            | Complete firmware string                                |
| Same query in 3+1 chunks               | Complete firmware string                                |
| `10 ff 20 f1 10 ff 30 10` in one write | **One notification**, 23 bytes: two consecutive strings |
| 12 zeros + firmware query in one write | Complete firmware string                                |
| Subsequent status query                | `00`                                                    |

For these queries, FF02 is therefore a byte stream rather than a “one write = one
command” protocol. FF01 likewise does not guarantee “one notification = one
response”: the experiment concatenated strings without a separator. Query tests
alone do not prove that every raster fragmentation pattern is safe.

Responses contain no opcode, request ID, or universal length. The library needs
one pending query, byte accumulation, and a decoder for the expected response.
The string lengths below apply to this device, not as global constants for all
models. Continuing the query sequence after a timeout is unsafe: a late response
may be mistaken for the next one. Research scans allowed this with a complete log
and a control version query; an application client should close a session whose
state is uncertain.

## 5. Queries tested on V1.36

### Identification

| Complete query | Response                                   | Length          |
| -------------- | ------------------------------------------ | --------------- |
| `10 ff 20 f0`  | ASCII `IP-200`                             | 6               |
| `10 ff 20 f1`  | ASCII `V1.36_203dpi`                       | 12              |
| `10 ff 20 f2`  | ASCII serial number                        | 14              |
| `10 ff 20 ef`  | ASCII `9.05`                               | 4               |
| `10 ff 30 10`  | ASCII `v3.38.21_AY`                        | 11              |
| `10 ff 30 11`  | ASCII `PeriPage_…`                         | 13 on this unit |
| `10 ff 30 12`  | Two identical consecutive 6-byte addresses | 12              |
| `10 ff 70`     | Composite string below                     | 80 on this unit |

Observed `70` format:

```text
name|address1|address2|firmware|serial|batteryPercent
```

This is ASCII without a trailing NUL. In this experiment, the entire response
arrived in one FF01 notification. Addresses are 17-character strings of the form
`XX:XX:XX:XX:XX:XX`. Android accumulates parts of the composite response, so the
parser must not depend on receiving a single notification. Validate the fields,
not just the number of `|` separators. After `70`, a firmware query returned a
correct response; this single experiment does not prove that `70` is completely
independent of subsequent printing.

**Reading worked without initialization in the measured connection:**
`read-only-01` started with firmware and Bluetooth version queries immediately
after subscribing, without `fe 01` or zeros. This did not test a separate cold
start after a power cycle.

### State, settings, and diagnostics

| Complete query | Measured response      | Interpretation and limits of knowledge                                                      |
| -------------- | ---------------------- | ------------------------------------------------------------------------------------------- |
| `10 ff 40`     | `00`                   | In the tested idle state; does not guarantee mechanical readiness                           |
| `10 ff 11`     | `01 0c 01`             | **3 bytes**; the semantics of all V1.36 fields are unconfirmed                              |
| `10 ff 13`     | `00 14`                | 20-minute auto-off according to the application format, `u16be`                             |
| `10 ff 50 f1`  | `00 4c`, later `00 4b` | Battery 76/75%; the application reads the second byte of the two-byte response              |
| `10 ff 50 f2`  | `00 00`                | Android `T0`: label height for PB40; meaning on A6 unknown, not a confirmed battery voltage |
| `10 ff 01`     | `00 00 06 40`          | 4 bytes, `u32be=1600`; purpose and units unknown                                            |
| `10 ff 02`     | `00 b4`                | 2 bytes, `u16be=180`; purpose and units unknown                                             |
| `10 ff 0f 00`  | `00 00 0c 08`          | Raw channel 0: 3080                                                                         |
| `10 ff 0f 01`  | `00 00 00 b8`          | Raw channel 1: 184                                                                          |
| `10 ff 0f 02`  | `00 00 08 d8`          | Raw channel 2: 2264                                                                         |
| `10 ff 0f 03`  | `00 00 00 0c`          | Raw channel 3: 12                                                                           |
| `10 ff ff a5`  | `f0`                   | One control argument matched the V1.22 nibble transformation                                |

The ADC channel purposes, voltage scale, and temperature formulas from V1.22 are
not confirmed. `10 ff ff n` was tested only with `n=a5`; the full V1.36
transformation table was not reconstructed.

The following queries produced no FF01 within a **900 ms** window:

```text
10 ff c0 00          charging query candidate from V1.22
10 ff 85             raw-mode query candidate
10 ff 0e 00 / 01 / f0 / f1
10 ff 0f 04 / 05
10 ff 20 f9
10 ff b0 02
10 ff c0 01 / 02
```

After this series, `10 ff 40` returned `00`, and the version query returned the
correct string. Unanswered commands must not appear in the UI as supported sensors
with zero values. They need an “unknown/not supported by this profile” result.

There is a specific conflict between families: Android `y6.a.h1` uses `10 ff c0 n`
as a **P90 speed write**, whereas V1.22 treats the same sequences as reads. The
plan name `read-only` reflects the origin of the hypotheses, not a guarantee that
state remains unchanged on every printer version. The `c0 00/01/02` series was
already executed on this unit; its lack of a response does not rule out a side
effect. No causal link to the feeding difficulty was established. These queries
should not be repeated in the ordinary client. A separate, narrow `status` plan
without these candidates is provided for routine checks.

### Android state codes

The status-query response branch in `y6.a` distinguishes exact hex strings:

| Value | Application label | Verification on this device            |
| ----- | ----------------- | -------------------------------------- |
| `00`  | Idle              | Observed                               |
| `01`  | Busy              | Not isolated in a separate experiment  |
| `03`  | Voice mode        | Not tested                             |
| `04`  | Out of paper      | Not tested by controlled paper removal |
| `08`  | Low battery       | Not tested                             |
| `10`  | Overheating       | Not tested                             |

**This is not yet a V1.36 bit map.** In particular, interpreting `03` as voice mode
does not justify calling it “busy + cover open”. The UI can confidently decode
only confirmed states; unknown bytes must be retained. Cover opening, end of roll,
and recovery from those conditions require controlled physical experiments.

## 6. Raster and print jobs

Format shared by V1.22, Android raw A6 output, and historical tests of this V1.36:

```text
10 ff fe 01                          job start
00 00 00 00 00 00 00 00 00 00 00 00  12-zero preamble
1d 76 30 m X:u16le Y:u16le           raster header
DATA                                 exactly X*Y bytes
1b 4a n                              feed after the image
10 ff fe 45                          job end
```

`X` is the width **in bytes**, and `Y` is the row count. Rows are consecutive;
bit 7 is the first dot in a byte, and `1` means heat/a black dot. Android `y0.h.w`
packs data this way, with an average RGB threshold of `<190`. A6 uses `X=48`, a
full raster width of 384 dots. Brightness threshold, dithering, and image rotation
are client algorithms, not additional protocol bytes. Do not add a header to each
ATT packet or pad the last packet with zeros: those bytes would become part of the
next command.

For the 384×96 test image:

```text
1d 76 30 00 30 00 60 00
<4608 raster bytes>
1b 4a c0
10 ff fe 45
```

Feed `c0` is 192 rows, nominally about 24 mm at 203 dpi. This is the requested feed,
not a measured paper displacement. For longer feeds, the application sends multiple
`ESC J` commands because the argument is one byte.

Android generates `m=0..3`, while V1.22 also understands ASCII `30..33` and
horizontal/vertical doubling. Only **m=0** was sent to V1.36 in this series.
Other modes, clipping, narrow-raster alignment, and handling of incorrect lengths
are unproven; the library should currently build a full 384-dot-wide raster.

Historical testing of this unit on 2026-08-19 established the user image's orientation
as mirror-X followed by a 180° rotation. This is context from earlier tests, not a
new measurement. The new geometry pattern contains the letter A, a corner marker,
and three differently sized squares to check row/bit direction on paper. A photo
of this pattern is needed before establishing a new orientation contract.

### `AA` does not confirm paper movement

In `query-extra-01`, `10 ff fe 45` produced `AA` **without a raster**, both before
and after the four-byte `fe 01`. The geometry test also received `AA`, but the user
reported that the paper did not move; the photo showed no new image. The user flow
therefore must not report “printed successfully” based only on this byte.

Distinguish delivery to the OS, returned transport credits, the `AA` event, and
visually confirmed printing. In V1.22, the end-of-job command is not a mechanical
barrier; V1.36's internals are unknown. In this series, `AA` arrived approximately
1.1–1.3 s after the final write, which alone establishes neither its exact meaning
nor a universal timeout.

### Compressed raster `1f 00` — failed experiment on IP-200/V1.36

Android `y0.h.z` creates:

```text
1f 00 X:u16be Y:u16be N:u32be COMPRESSED
N = Code.code(rawBitmap).length - 2
COMPRESSED = Code.code(rawBitmap)[2:]
```

`Code.code` is a JNI function in `libCode`. The Java code establishes removal of
the first two bytes and the header format; it does not by itself reveal the
compressor parameters. V1.22 successfully executed a zlib stream with a 1024-byte
window, the two-byte header removed, and Adler-32 retained. On September 29, 2026,
this variant was tested on the physical IP-200/V1.36: **it produced garbage
characters and excessive paper feed instead of the label**. The user provided a
photo of the result. This variant must not be enabled for this profile or treated
as successful merely because BLE credits were returned.

The experiment used the Homebox label from `src/lib/label/example.json`, rendered
by the regular `renderTemplate`: 384×115, 48 bytes per row, 5520 bytes at 1bpp.
The TypeScript generator `scripts/firmware/compressed-raster.ts` uses:

```ts
const zlib = deflateSync(raw, { level: 6, windowBits: 10 });
// zlib[0:2] = 28 91; the final four Adler-32 bytes are retained.
const body = zlib.subarray(2);
```

The body was 739 bytes (an 86.61% reduction, 7.47 times smaller), or 749 bytes
including the header. Header: `1f 00 00 30 00 73 00 00 02 e3`. Round-trip
decompression and Adler-32 `ec023189` were checked before transmission. The same
stream was then executed separately by **the actual V1.22 decoder** in Unicorn:
return value 0, all 747 handler input bytes consumed (8 field bytes + 739 body
bytes), and all 115 rows produced with no differences. The allocator, byte input,
and row queue were replaced; this checks a different firmware's decoder, not
V1.36 mechanics.

Send sequence: `10 ff fe 01`, 12 zeros, the `1f 00` header, the body, `1b 4a 60`
(feed 96), and `10 ff fe 45`. Commands were separate; the body used chunks of up
to 100 bytes with FF03 accounting. Job: 13 FF02 writes / 772 bytes, approximately
0.23 s from the first to the final CoreBluetooth send. This is transport queueing
time, not print time. The subsequent status query adds one write and three bytes;
final balance: 18 credits granted, 14 spent, 4 remaining.

For approximately 5.9 s after the end command, there was neither `AA` nor a response
to the status query in the same connection. After reconnecting, information queries
responded again: `V1.36_203dpi`, status `00`, settings `01 0c 01`. The last two
values matched the pre-experiment queries. This confirms printer availability
after the experiment, but does not check all settings or provide a control print
using the ordinary path.

The photo shows groups of text characters and large blank gaps.
**Interpretation:** the compressed raster command was unrecognized or unsupported
in this mode, so its body entered ordinary text/command parsing. This observation
cannot identify the exact V1.36 machine-code branch or rule out another, as yet
unknown compressed printing mode. The Y/N validation defects and narrow compressed
raster placement from V1.22 are not asserted to be V1.36 properties either.

Android's selection agrees with this result: `y0.h.n` calls `z` for an explicit
list of families (A8, A9, A40, H2, P40, and others); the ordinary name
`PeriPage_5604` does not match its conditions and selects `F` (`GS v 0`).
`y6.a.w1` also has branches for newer families through `C`/`y0.h.o`, so the
presence of the shared `z` method alone does not imply compression support on
every PeriPage.

Artifacts in `storage/firmware/live-v1.36/compressed-01/`: `homebox.bin`,
`expected.png`, `compressed.bin`, `compressed-command.bin`, `compression.json`,
`plan.json`, `print.jsonl`, `status-before.json`, `status-after.json`,
`v122-decode-full.json`, and `user-result.jpg`. Source raster SHA-256:
`0e87cbea8cfa80c06f53b541fbd5fd8109a021ba06d0e486f519a836d0dbc735`;
compressed body SHA-256:
`dde2f12a5e5ad27b59f96caffba48af66fadf072d2871c737e0ed4bc4dda0fef`.
The main browser client continues to use uncompressed `GS v 0`.

### Text, QR, and additional commands

V1.22 has its own ASCII text, `ESC a`, `ESC !`, `GS !`, `LF`, and QR command
`1d 6c scale ecc len:u16le data`. These handlers were not tested on V1.36 here.
A matching `GS v 0` format does not imply full ESC/POS support. In particular,
`ESC @` must not be used as a guaranteed reset, or `GS r` as a status query.
The initial client can render text/Cyrillic and QR codes as rasters.

## 7. Findings from mobile application analysis

### Android International 6.10.11

Package `com.ileadtek.peripage`, versionCode 323, base APK SHA-256:

```text
cb4f33830ad97937875c67a7f6c8e6f9c2fedc32f490a176832db1a1f369e234
```

This is a saved PeriPage application APK from the APKPure mirror, not manufacturer
source code. The URL and outer XAPK hash are saved in `storage/firmware/manifest.json`.
Main references after JADX:

| Class/method          | Observation                                                                         |
| --------------------- | ----------------------------------------------------------------------------------- |
| `y0.h.w`              | Row-major, MSB-first, width rounded up to a byte                                    |
| `y0.h.F`              | Separate `GS v 0` header, followed by the body                                      |
| `y0.h.X`, `P`, `b0`   | Start `fe 01`, 12 zeros, end `fe 45`                                                |
| `y0.h.k`              | `ESC J n`                                                                           |
| `y0.h.z`              | Compressed raster header and removal of two bytes from the JNI result               |
| `y0.h.n/o`            | Selection of `z` or `F`; ordinary A6 is absent from the compression list in `n`     |
| `y0.h.a/b/c/d/e/e0/f` | Queries for MAC, Bluetooth version, firmware, serial, combined info, battery, model |
| `y6.a.w1`             | Selection of raw/compressed by device family, followed by feed and end              |
| `y6.a`, case 20       | State labels from section 5                                                         |
| `y6.a`, case 31       | Two-byte battery response                                                           |
| `y6.a`, case 32       | Accumulation of combined-info string fragments                                      |
| `y6.a`, case 6        | The application accepts `AA` at the start/end of a response as a completion event   |

Transport `y0.e` uses Bluetooth Classic SPP/RFCOMM. Its 1024-byte chunks and
`sleep(1 ms)` in `y0.h.G` **are not a BLE transmission recipe**. They confirm command
bytes and job assembly order, but do not replace FF03 credits. Decompilation of
the main DEX finished with 24 errors in other/adjacent methods, and there are JADX
warnings. Conclusions are limited to readable byte arrays and traced calls. Broken
control flow in `y0.e.l` was not used to reconstruct asynchronous status-prefix
semantics.

State-changing commands were found but **not sent**:

| Command             | Application source/purpose                                              | V1.36 status                                    |
| ------------------- | ----------------------------------------------------------------------- | ----------------------------------------------- |
| `10 ff 10 00 n`     | `h.S`: density                                                          | Used historically; no new A/B test              |
| `10 ff 10 03 n`     | `h.E`: paper type                                                       | Significant difference from V1.22 selector `02` |
| `10 ff 12 u16be`    | `h.N`: auto-off                                                         | Static format only                              |
| `10 ff 81 n`        | `h.l/y`, `y6.a.a1/b1`: backfeed amount, model-dependent limit of 80/120 | Exact V1.36 action untested                     |
| `10 ff 03`          | `h.R`: calibration                                                      | Not performed                                   |
| `10 ff a0 00 u32be` | `h.Q`: mileage/recharge counter                                         | **Not a density command**                       |
| `10 ff a0 01`       | `h.d0`: read the same counter                                           | Not queried                                     |
| `10 ff 20 ee n`     | `h.j`, `y6.a.J0`: random challenge/user-key                             | Do not confuse with the tested `10 ff ff n`     |
| `10 ff fd 01`       | `h.Y`                                                                   | Exact semantics unknown                         |
| `10 ff 80 00/01`    | `h.a0/Z`; `01` is called from `y6.a.a1` for the backoff function        | Exact V1.36 semantics unknown                   |

Resets, calibration, identifier writes, maintenance mode, and firmware updates
are outside the confirmed working contract. The `e0/ee aa aa` commands and
maintenance frames known from V1.22 were not tested on V1.36.

### Chinese Android application

Saved versions: `com.ailide.apartmentsabc` 5.0.5/code166 and 6.14.0/code310.
The former is protected by Tencent StubShell/WrapperProxy, the latter by
jiagu/StubApp. Available Flutter strings do not expose the complete Java protocol.
These APKs therefore form part of the research provenance but do not independently
confirm the V1.36 command table. Their hashes are in the earlier manifest.

### Public iOS BLE trace

Source: [PacketLogger fixture](https://github.com/elkusbry/peripage-tool/blob/053da0e0b3cd23eef509ec78297b999b2bc5936b/fixtures/peripage_capture.pklg),
commit `053da0e0b3cd23eef509ec78297b999b2bc5936b`. The
[supplied parser's description](https://github.com/elkusbry/peripage-tool/blob/053da0e0b3cd23eef509ec78297b999b2bc5936b/fixtures/parse_pklg.py)
calls it a capture of the official application from an iPhone. This is the trace
author's statement; no capture was made from the user's own phone.

File: 52,053 bytes; SHA-256:

```text
008a838b21ddd99bc21be70688bb296d1161bde160abe5a88cdc3d8155289eab
```

An independent TypeScript parser reconstructed 721 records and 341 ATT write
commands without response (`0x52`) to handle `0x0012`, totaling 33,808 bytes:

```text
10 ff 10 00 01                     density
10 ff fe 01
<1024 zero bytes>
1d 76 30 00 48 00 c7 01            72 bytes × 455 rows
<32760 raster bytes>
1b 4a 60
10 ff fe 45
```

Chunks: 337×100 bytes, 1×95, 2×4, and 1×5. Notifications go to handles `0x000f`
and `0x0014`; this capture contains no UUID table, so the file itself does not
establish which handles correspond to FF01/FF03.

The **576-dot** width points to a different A6+/304 dpi profile; this is not a log
from our V1.36/203 dpi device. Its format and packetization technique are useful,
but its 1024 zeros and width of 72 must not be copied into the A6 profile as
mandatory parameters.

The parser uses this file's LE length and LE seconds/microseconds. The upstream
comment/code uses BE timestamps, which produce invalid time values for these bytes.
ACL fragments are reassembled separately by connection and direction before
L2CAP/ATT parsing. The upstream Python code was not executed.

## 8. Differences from V1.22 that affect the client

| Area                         | V1.22 from the image                       | Physical V1.36                                            | Consequence                                               |
| ---------------------------- | ------------------------------------------ | --------------------------------------------------------- | --------------------------------------------------------- |
| Model                        | `A6_SD`                                    | `IP-200`                                                  | Different profiles, not just version numbers              |
| Initial credits              | 7                                          | 4                                                         | FF03 takes precedence; fallback profile in section 3.1    |
| Chunk parameter              | 182                                        | 100                                                       | Do not carry over packet size                             |
| `10 ff 11`                   | 4 bytes                                    | 3 bytes                                                   | Different decoders/response lengths                       |
| `10 ff 01`                   | 12 bytes, with part of the tail unreliable | 4 bytes                                                   | Cannot use the V1.22 structure                            |
| `10 ff 30 10`                | No response in the analyzed branch         | ASCII Bluetooth version                                   | Different command implementation/routing                  |
| Diagnostics `0e`, `c0`, `85` | Implemented in the image                   | No FF01 in short experiments                              | Availability unconfirmed                                  |
| `0f`                         | Six channels in the code                   | Channels 0–3 responded                                    | Channel map and physical units unknown                    |
| Paper type                   | Selector `02`, physical meaning unknown    | Android uses `03`, untested on V1.36                      | Do not carry over the setter blindly                      |
| Status                       | Bit logic known from code                  | Device returned `00`; Android has model-specific labels   | Do not promise cover diagnostics in the UI based on V1.22 |
| `AA`                         | Internal mechanism known                   | Received both without a raster and without paper movement | A protocol event, not a physical guarantee                |
| Compression `1f 00`          | Decoder reconstructed the control raster   | Garbage characters and excess feed instead of a label     | Do not use for the tested profile                         |
| Maintenance frames           | Reconstructed from code                    | Untested                                                  | Keep out of the initial API                               |

The shared structure — FF00, credits, stream, identification, raw raster, feed/end —
remains. Compatibility with all 33 V1.22 vendor opcodes has not been established.

## 9. Physical experiment log and limits of the results

Source files are in `storage/firmware/live-v1.36/`. Basenames are listed below;
TS probes have a `.json` file with the plan/responses and a `.jsonl` event log.

| Experiment                   | What was sent                                               | What was established                                                                         |
| ---------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `initial-probe.log`          | Information queries using the previous CoreBluetooth client | Live identification and GATT                                                                 |
| `read-only-01`               | 26 queries without initialization                           | Responses from section 5; FF03 before the first command                                      |
| `query-extra-01`             | Additional queries, two empty end commands                  | In particular, `AA` without a raster                                                         |
| `framing-01`                 | Fragmented/combined queries                                 | Stream processing and combined FF01 responses                                                |
| `geometry-01`                | 384×96, init in one write, the remainder as a shared stream | 48 writes / 4639 bytes; `AA`; user confirmed no movement                                     |
| `feed-01`                    | Init + feed255 + end                                        | `AA`; physical feed not independently confirmed                                              |
| `geometry-separated-01`      | Same image, separate commands                               | `AA`; no independent visual validation                                                       |
| Mobile control print         | User adjusted the paper and printed from the application    | GoPro showed `Test`; user confirmed operation                                                |
| `geometry-separated-02`      | Retry after the mobile application                          | Discovery timeout, **0 writes**; not a print protocol test                                   |
| `geometry-separated-03`      | Retry after releasing BLE                                   | 52 writes / 4639 bytes; `AA`; photo showed the previous sheet without the new pattern        |
| `legacy-control-line-01.log` | One 384×11 line, feed120 with the previous driver           | 559 wire bytes, `AA`; user heard printing but paper remained stationary                      |
| Standalone QR via button     | No BLE                                                      | Initially sound without movement; user reported recovery after several attempts              |
| `feed-02`                    | Init + feed255 + end after recovery                         | Feed confirmed by before/after photos, without heating                                       |
| `geometry-separated-04`      | Same raw pattern                                            | 52 writes, `AA`; printer was already out of frame when photographed, result not yet assessed |
| `geometry-separated-05`      | Same raw pattern after user cleaning                        | 52 writes, `AA`; paper emerged with three visible marks; full pattern obscured/curled        |
| `feed-03`                    | Additional blank feed of 255 rows                           | Paper advanced further, but the pattern curved out of view                                   |
| `compressed-01/print`        | 384×115 label, `1f 00`, zlib/1024 without header, feed96    | 739-byte body; FF03 returned, no `AA`; user photo shows garbage text and excess feed         |

Both geometry variants contain 4608 bytes of the same image. Credit balance check:

| Experiment              | Credits granted | Spent | Remaining | Last write → AA |
| ----------------------- | --------------- | ----- | --------- | --------------- |
| `geometry-01`           | 52              | 48    | 4         | 1.260 s         |
| `geometry-separated-03` | 56              | 52    | 4         | 1.116 s         |
| `geometry-separated-04` | 56              | 52    | 4         | 1.134 s         |
| `geometry-separated-05` | 56              | 52    | 4         | 1.169 s         |

Changing write boundaries alone did not fix the problem. The previous driver also
discards initial credits before the raster header and waits for new grants; this
did not produce visible feed in the control-line test either. This difference
cannot be treated as the established cause of the stationary paper.

After cleaning with alcohol, the user reported improved grip. The
`geometry-separated-05` retry sent **the same 52 ATT payloads, byte for byte**,
with the same boundaries as `geometry-separated-03`; only actual timings differed.
The comparison is saved in `cleaning-comparison.json`. Complete wire-stream SHA-256:
`706037c96338bfbbbe18d39bd5e04eec69ee8864d20f12a1221a171e70e2aac2`.
Three pattern marks appeared in `geometry-separated-05.jpg`. This confirms actual
raster output, but not the full geometry or feed accuracy. After another 255 rows,
`geometry-separated-05-fed.jpg` shows the white surface of curled paper; the
flattened printout needs to be viewed. A subsequent `status-after-cleaning-01`
read returned firmware `V1.36_203dpi`, status `00`, the same settings response
`01 0c 01`, and battery `00 3f` (63%). Matching three settings bytes does not prove
that the entire configuration is unchanged.

`paper-corrected-before.jpg` and `geometry-separated-03.jpg` show the same visible
fragment with `Test`; the new raster with A and three squares was not found.
`geometry-separated-02.jpg` was taken during a connection attempt with no writes
and is not a print result.

**Paper feed and raster marks are confirmed; verification of the complete image remains open.**
`feed-recovery-before.jpg` and `feed-02.jpg` show a blank section of paper emerging
after the command. The exact travel distance was not measured from these photos.
Standalone printing also initially failed to move the paper, so the problem
occurred without our BLE client. The cause and durability of the recovery are
unknown. Jobs involving heating were paused until a blank feed succeeded.
The standalone QR control print, triggered by two short presses of the power
button, is described in the
[official FAQ](https://www.peripageglobal.com/pages/f-a-q); it allows checking the
mechanism without a BLE client. A separate button-operated feed function for A6
has not been confirmed here.

## 10. Reproduction and reuse in a library

Code: [scripts/firmware](../scripts/firmware/README.md). Scenarios and parsers are
TypeScript. Swift contains only system BLE transport, JSONL IPC, and CoreBluetooth
backpressure. Project packages already provide Bun, TypeScript, and Vitest; these
experiments required no new dependencies. The decompiler remains in the separate
`firmware` dev shell.

```sh
nix develop
bun install --frozen-lockfile
bun scripts/firmware/plans.ts status
bun scripts/firmware/probe.ts \
  storage/firmware/live-v1.36/status.json \
  storage/firmware/live-v1.36/status-01

bunx tsc -p scripts/firmware/tsconfig.json
bunx --bun vitest run --config scripts/firmware/vitest.config.ts
bun scripts/firmware/inspect-trace.ts \
  storage/firmware/live-v1.36/geometry-separated-03.jsonl
```

Repeating the hardware tests requires macOS with Xcode and Bluetooth permission.
Nix pins the tools, not macOS, the radio stack, the paper roll's condition, or the
phone application. Offline parsers and byte/credit tests do not require a printer.
Six tests check the measured header, payload length, field overflow protection,
additive credits, and conservative pausing. This does not simulate the motor.

The main Android DEX can be reproducibly extracted and decompiled as follows:

```sh
nix develop .#firmware -c sh -c \
  'unzip -p storage/firmware/com.ileadtek.peripage.apk classes.dex > storage/firmware/live-v1.36/classes.dex'
nix develop .#firmware -c jadx --no-res \
  -d storage/firmware/live-v1.36/android-international \
  storage/firmware/live-v1.36/classes.dex
```

JADX errors must be considered separately: a nonzero exit code for the entire DEX
does not invalidate every method, but neither does it confirm reconstruction of
the whole application. `y6.a` is in the previously analyzed classes2/classes3 under
`storage/firmware/research/jadx-out/sources/`.

Research scenarios in `scripts/firmware/` and artifacts in `storage/firmware/` are
excluded from Git; command formats and significant results are retained in this
document. Logs, firmware/APKs, derived files, and photos are in storage. A separate
`live-v1.36/manifest.json` records current sources and checksums; the historical
V1.22 research manifest is not relabeled as new hardware evidence.

Pure byte/credit primitives and the shared `BleTransport` are already suitable for
a future browser library. The next verifiable step is a complete raw job through
the browser, with visible feed and a preview-to-paper comparison. After that,
20/100-byte chunks, sustained transfer, disconnection mid-raster, multiple jobs in
one session, and real paper/cover states should be tested separately. The tested
`1f 00` compressed format failed on the current profile; it continues to use
`GS v 0`. Built-in QR/text and state-changing commands remain separate capabilities
requiring their own compatibility checks.
