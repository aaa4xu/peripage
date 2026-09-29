# PeriPage A6_SD V1.22 BLE protocol

This document was reconstructed from the machine code of the **A6_SD /
V1.22_203dpi / NN0000210** firmware, rather than assuming ESC/POS compatibility.
Analysis date: 2026-09-29. It covers the BLE transport, command stream, responses,
print control, and the maintenance protocol accessible over BLE. USB is out of scope.

Main result: all **33 recognized `10 ff` opcodes**, the GATT path, credit algorithm,
uncompressed and compressed rasters, QR command, and response conditions are known.
The meaning of some factory parameters and the reachability of certain states
remain unknown; these are explicitly identified below.

## 1. Source, applicability, and notation

| Field                    | Value                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File                     | `NN0000210_A6_SD_V1.22_203dpi_20260321.bin`                                                                                                             |
| Size                     | 80,404 bytes                                                                                                                                            |
| SHA-256                  | `2ab46e818ea6a61ebe68eff37c2e15e9b41eb66c527a4076f51b53695c93d424`                                                                                      |
| Build strings            | `Mar 21 2026`, `16:29:06`                                                                                                                               |
| Application architecture | ARM Thumb, little-endian, M-profile                                                                                                                     |
| Load base                | `0x01020000`                                                                                                                                            |
| Image source             | [Object retrieved through the official PeriPage API](https://ailide-no.oss-cn-shenzhen.aliyuncs.com/haiwai/cloud/20260326/aQrWUTaqPA20260326171100.bin) |

The image contains unencrypted application executable code. It is not a complete
chip dump: ROM, the individual printer's saved configuration, and some resources
are outside the file. Initial RAM data was reconstructed with the startup decoder:
297 compressed bytes → 916 bytes at `RAM 0x20000`.

Below, `@0x1234` means a **file offset**. The virtual instruction address is
`0x01020000 + 0x1234`; bit 0 of a Thumb pointer is excluded before addition.
State addresses are explicitly marked `RAM`. This allows the findings to be
checked against the original image without symbols or research scripts.

Format notation:

- Command bytes are hexadecimal: `10 ff 20 f1`. Numbers in prose are decimal.
- `u16be`, `u32be` — most significant byte first; `u16le` — least significant byte first.
- `n`, `s`, and `m` are one byte unless otherwise specified.
- `OK = 4f 4b`, `ER = 45 52`, `RE = 52 45`, `AA = aa`.
- “No response” means that the command itself produces no response on `FF01`.
  Transport notifications on `FF03` continue.
- “Save” means the code calls a configuration write to flash; this analysis does
  not verify that the physical write succeeds.

Exact bytes, sizes, branches, and addresses in this document are confirmed by the
code. “Likely” and “unknown” mark the limits of interpretation. An additional
**813 isolated Thumb-code checks were run in Unicorn**, replacing stream reads,
response transmission, peripherals, and selected runtime functions. These check
parsers and data transformations, rather than emulating the entire printer.
BLE connections, real sensors, the motor, and printing were not tested here.

## 2. BLE service and channels

The full UUID for a short `FFxx` value is `0000ffxx-0000-1000-8000-00805f9b34fb`.

| UUID   | Properties in the table                 | Direction and purpose                                |
| ------ | --------------------------------------- | ---------------------------------------------------- |
| `FF00` | Service                                 | Main application service                             |
| `FF01` | Notify (`0x10`)                         | Printer → client: command responses and print events |
| `FF02` | Write + Write Without Response (`0x0c`) | Client → printer: byte stream                        |
| `FF03` | Notify (`0x10`)                         | Printer → client: transfer parameters and credits    |

Evidence: initial structures at `RAM 0x201ad`, `0x201c4`, `0x201ca`, and `0x201d0`;
registration at `@0x2292`, `@0x22a2`, and `@0x22b2`.
Returned SDK handles are stored at `RAM 0x2019c`, `0x2019a`, and `0x2019e`.
Numeric ATT handles are assigned during registration and must not be hardcoded in
the client.

The image also registers ISSC-family UUIDs. However, the analyzed command receiver
at `@0x1714` checks specifically for the `FF02` handle. Equivalence of the ISSC
channel to this protocol has not been established.

### Discovery and subscription

Initialization creates a name of the form `PeriPage_%02X%02X_BLE`. The advertising
code at `@0x2356` contains the field `05 02 12 18 e7 fe`: a list of 16-bit UUIDs
`1812`, `FEE7`. The presence of `FF00` in GATT does not mean it is announced in this
advertising field. The response to the name command `10 ff 30 11` comes from a
different string and may omit the `_BLE` suffix.

The sequence implied by the code is:

1. Discover `FF00` and its characteristics.
2. Enable `FF01` notifications to receive responses.
3. Enable `FF03` notifications; this triggers the initial credit grant.
4. Parse `FF03` separately from `FF01`, then send commands to `FF02`.

The `FF03` CCCD write handler compares the handle with `handle(FF03) + 1` and
checks whether the first value byte is `01`. On this event, it sends the following
in order:

```text
FF03 ← 02 b6 00
FF03 ← 01 07
```

The command `10 ff fe 01` does not trigger these notifications. Pairing/bonding
conditions and the negotiated ATT MTU are not established by this application path.

### Notification contents

Inside the SDK, an LE16 handle is added to the payload. This is an internal
representation between the application and Bluetooth controller; **these two bytes
are not part of the payload received by the BLE client**. Response transmission:
`@0x2570`, `@0x25d8`; flow-control notifications: `@0xb02c`, `@0xb048`, `@0xb068`.

The SDK wrapper at `@0x1878` rejects its own packets with payloads ≥254 bytes.
This is a local function limit, not a proven ATT write/notification size.
The analyzed application sender has no generic fragmentation of long responses;
its behavior with a small MTU requires separate measurement.

## 3. `FF03` credits and the receive ring buffer

| Payload    | Decoding   | Established meaning                                                            |
| ---------- | ---------- | ------------------------------------------------------------------------------ |
| `01 N`     | `N: u8`    | Number of credits for input-stream writes; `00` is used when grants are paused |
| `02 nL nH` | `P: u16le` | Transfer parameter; `P=182` on subscription                                    |

The likely purpose of `02` is the allowed data chunk size. **The application code
does not prove that it equals ATT MTU, `MTU-3`, or a hard FF02 limit.** Using
182-byte chunks also requires respecting the actual BLE transport limit.

For `01`, the counter increases by one **per nonempty FF02 write event**, regardless
of its byte count. It is not a row count, byte count, or the index of the last
acknowledged command. Returned credits are cumulative: add them to the sender's
remaining budget. The initial budget in this image is 7. The exact client policy
for `01 00` must account for writes already sent. A conservative implementation
stops new writes until a positive grant, keeping separate sent and returned counters.

Device state:

| RAM                  | Purpose                                  |
| -------------------- | ---------------------------------------- |
| `0x23d90`            | Byte receive ring buffer, 8192 bytes     |
| `0x20064`, `0x20068` | Write and read indices                   |
| `0x2006c`            | Occupied byte count                      |
| `0x20190`            | `paused` flag                            |
| `0x20192`            | 16-bit counter of credits pending return |

BLE branch algorithm (`@0x1714`, `@0x16ec`, `@0x81a8`, `@0xafe8`, `@0xb008`):

```text
on a nonempty FF02 write:
    copy the payload into the byte ring buffer
    pending = (pending + 1) mod 65536
    free = 8192 - occupied
    if free < 3276:
        send FF03: 01 00
        paused = 1
        retain pending
    else:
        send FF03: 01 (pending mod 256)
        pending = 0

periodic check:
    if paused != 0 and free > 4915:
        paused = 0
        send FF03: 01 (pending mod 256)
        pending = 0
```

The thresholds are strict: grants still occur at `free=3276`; they do not yet
resume at `free=4915`. Code execution verified these boundaries and the initial
`182/7` values.

Implementation details relevant to clients:

- A normal positive grant in the FF02 handler does not itself clear `paused`.
  A later periodic branch may send `01 00` with `pending` already zero.
  This is therefore not a separate, formally complete `PAUSE/RESUME` protocol.
- Only the counter's low byte is included in the notification. Unacknowledged
  writes must not accumulate without a bound.
- `pending` is cleared after the send attempt; the sender's result is ignored.
  This code does not automatically recover a lost notification.
- The low-level function at `@0xa200` stops adding bytes at an occupancy of
  **8128**, leaving 64 bytes in reserve. Its caller at `@0xa2b0` continues the
  loop, returns success, and does not report each dropped byte to the credit
  handler. In an isolated check, a write to a full ring buffer was counted in
  `pending` even though its payload did not enter the buffer.

Thus, a credit acknowledges input flow control. It **does not prove unconditional
delivery of all bytes when flow control is violated, command parsing, or print
completion**. A successful ATT write is another separate layer.

## 4. Command stream, responses, and error recovery

The main loop at `@0x9764` obtains bytes through `@0x4350` and passes them to
`@0x275c`. Commands can cross BLE write boundaries; multiple commands can share a
single write. The prefix appears only at the start of a command, not at every
raster chunk. Escape sequences inside image payloads are not commands while the
image handler is correctly consuming that payload.

Regular commands and responses have no common frame length, checksum, request ID,
or echoed opcode. The maintenance protocol in section 10 is the exception.
Response length depends on the specific query. Most strings are sent without NUL;
fixed responses can differ, for example `10 ff d0` includes a trailing `00`.

Queries on `FF01` require only one pending response at a time. Otherwise, a
setting's `OK` cannot be unambiguously distinguished from an asynchronous page
search `OK`. A BLE notification alone does not identify the command that caused it.

### Reads and timeouts

| Function        | Behavior when no byte is available                                                 |
| --------------- | ---------------------------------------------------------------------------------- |
| `@0xa0a4`       | Waits in 2-scheduler-tick intervals; returns `0x100` after the counter exceeds 300 |
| `@0xa0e8`       | Waits in 10-tick intervals; returns `0x1ff` after the counter exceeds 500          |
| `@0x2b0c(1000)` | Up to 1000 waits of 1 tick, then `-1`; used by compressed rasters                  |

The scheduler tick frequency is unknown here: do not label these values as
milliseconds without verification. String handlers and many vendor handlers narrow
`0x100` to `u8`, producing `00`, or include it in field arithmetic. An interrupted
command therefore does not always mean cancellation: it may change a parameter,
terminate and save an incomplete string, or corrupt the next payload's size.

An unknown `10 ff xx` opcode is consumed without a response or argument reads.
The supposed arguments of an unknown command then enter the main stream. This is
not a safe way to discover commands by brute force on a physical device.

The outer reader at `@0x4350` has a separate branch for bytes **`>0x80`**: it skips
data and searches for the marker sequences `10 ff fe 01/45` using the state
machine at `@0x3a24`. This is not a UTF-8 decoder. A standalone binary stream
without a correct image header must not be sent as text. Internal body reads for
`GS v 0` and `1f 00` bypass this outer filtering.

## 5. All `10 ff` vendor commands

The first column gives the suffix **after `10 ff`**. The complete dispatcher is
at `@0x4ec8–0x5208`; the list was verified by exercising all 256 opcodes in isolated
execution. The table describes correctly supplied arguments; interrupted commands
have the exceptions described in the previous section.

| Suffix       | Arguments / `FF01` response      | Action and limitations                                                                                                                      | Reference code       |
| ------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `00 v:u32be` | `OK`                             | Save the low 16 bits of `v` to the sensor threshold at `RAM 0x25fc6`                                                                        | `@0x4fba`            |
| `01`         | 12 bytes                         | The first `u32be` is the same 16-bit threshold; the remaining 8 bytes have no stable contract                                               | `@0x42e8`            |
| `02`         | `u16be`                          | ADC channel 3 reading                                                                                                                       | `@0x4fea`            |
| `03`         | `OK` / `ER1` / `ER2` / `ER3`     | Paper sensor calibration with motor movement and possible threshold saving                                                                  | `@0x855c`            |
| `04`         | `OK`                             | Reset configuration fields to factory defaults and save                                                                                     | `@0x5544`            |
| `05 v:u32be` | `u32be`                          | Temporarily apply the low byte of `v` to PWM, wait 100 ticks, measure ADC 3, and restore the saved PWM                                      | `@0x5038`            |
| `06 v:u32be` | `OK`                             | Save the low 8 bits of `v` to `RAM 0x26026` and apply PWM                                                                                   | `@0x507e`            |
| `0e s`       | Usually `u16be`                  | Diagnostic parameters; details below                                                                                                        | `@0x449c`            |
| `0f s`       | `u32be` for `s=0..5`             | ADC: subcommands map to channels `[0,1,3,4,2,5]`; otherwise no response                                                                     | `@0x4014`            |
| `10 s n`     | `OK` / `ER`                      | Density, speed cap, or raw parameter; an unknown `s` neither reads `n` nor responds                                                         | `@0x55e0`            |
| `11`         | 4 bytes                          | `[density, speedCap, paperFlag, rawMode]`                                                                                                   | `@0x50c2`            |
| `12 t:u16be` | `OK` if `t<1440`, otherwise `ER` | Save the auto-off parameter at `RAM 0x26024`; `0` disables the condition                                                                    | `@0x4f08`            |
| `13`         | `u16be`                          | Read `RAM 0x26024`                                                                                                                          | `@0x50e2`            |
| `20 s …`     | Strings or `OK`                  | Identification and factory string writes; not all subcommands are queries                                                                   | `@0x7b58`            |
| `30 s …`     | Depends on `s`                   | Name, Bluetooth addresses, SDK control flag                                                                                                 | `@0x20d0`            |
| `40`         | 1 byte                           | State bitmask                                                                                                                               | `@0x4420`            |
| `50 s`       | `u16be`                          | Battery or paper measurement                                                                                                                | `@0x50f4`            |
| `64`         | No direct response               | Insert a `Selftest` job into the internal stream                                                                                            | `@0x74a4`            |
| `70`         | ASCII, variable length           | Composite information string with six fields                                                                                                | `@0x404c`            |
| `80 n`       | None                             | `RAM 0x26027 = (n == 1)`; flag purpose unknown; no immediate save                                                                           | `@0x512e`            |
| `81 n`       | None                             | Save a raw byte to `RAM 0x26029`; meaning/units unknown                                                                                     | `@0x4f5e`            |
| `85`         | 1 byte                           | Read the raw parameter at `RAM 0x2602b`                                                                                                     | `@0x5146`            |
| `b0 s`       | 20 ASCII bytes for `s=02`        | `Mar 21 2026 16:29:06`; other `s` values produce no response                                                                                | `@0x514e`            |
| `c0 s`       | Depends on `s`                   | Power and raw settings; see below                                                                                                           | `@0x5180`            |
| `d0`         | `35 34 36 31 39 33 34 00`        | Constant `5461934` with NUL; purpose unknown                                                                                                | `@0x4f76`            |
| `e0 aa aa`   | None over BLE                    | Enable `1b 10` maintenance frame mode; any other two bytes do not enable it                                                                 | `@0x51a4`, `@0x8c18` |
| `ee aa aa`   | None over BLE                    | Same branch as `e0`                                                                                                                         | `@0x51a4`            |
| `ef s`       | 24 ASCII bytes for `s=f6`        | 12 `0` characters, then six bytes from `RAM 0x20162` in reverse order as uppercase hex; likely a hardware identifier; otherwise no response | `@0x4500`            |
| `f0 n`       | None                             | Feed `n` blank rows; no feed if the argument times out                                                                                      | `@0x4f92`, `@0x6b64` |
| `f4`         | No direct response               | Another built-in test/information sheet                                                                                                     | `@0x7114`            |
| `f8 n`       | None                             | `RAM 0x20088 = (n == 1)`; flag purpose unknown                                                                                              | `@0x381c`            |
| `fe s`       | Depends on `s`                   | Start permission and end-of-job marker                                                                                                      | `@0x6504`            |
| `ff n`       | 1 byte                           | Transformation of two nibbles; formula below                                                                                                | `@0x7f84`            |

### Identification: `10 ff 20 s`

| `s`                  | Response / action                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `ef`                 | String from `RAM 0x26061`, length `strlen`; hardware/maintenance version string, with its value dependent on external state |
| `f0`                 | Exactly 5 bytes, `A6_SD`                                                                                                    |
| `f1`                 | Exactly 12 bytes, `V1.22_203dpi`                                                                                            |
| `f2`                 | Serial string at `RAM 0x25fc8`, without NUL                                                                                 |
| `f3 text terminator` | Write up to 20 bytes to `RAM 0x25fe6`, save, and respond with `OK`                                                          |
| `f4 text terminator` | Write up to 29 bytes to the serial string, set a maintenance flag, save, and respond with `OK`                              |
| `f9`                 | Exactly 9 bytes, `NN0000210`                                                                                                |
| Others               | No response; no additional arguments are read                                                                               |

`f3` appears to be a production date: the initial field value is `2024-09-09`.
There is no calendar-format validation. Both strings accept bytes `20..7f` except
comma `2c`; the first byte outside this set terminates the string and is consumed.
NUL is a valid explicit terminator. The byte range includes `7f`, although it is
not printable ASCII.

When the limit is reached, the handler **reads one more byte first**, then exits
without storing it. It does not drain the rest of an overlong string. A timeout
becomes NUL and also completes the write with `OK`. These commands therefore must
not be used as harmless information queries.

### Bluetooth information: `10 ff 30 s`

| `s`                    | Format                                                                  |
| ---------------------- | ----------------------------------------------------------------------- |
| `11`                   | `strlen` bytes from `RAM 0x25ffb`, without NUL                          |
| `12`                   | Exactly 12 raw bytes from `RAM 0x29fda`: two groups of six, not ASCII   |
| `22 n`                 | Pass boolean `(n == 1)` to the SDK; `OK` on SDK success, otherwise `ER` |
| Others, including `10` | No response                                                             |

The radio-level purpose of boolean flag `22` is unknown (`@0x1c78`, internal SDK
command `0x0c`). It must not be described as enabling pairing, discoverability,
or BLE without further evidence.

`10 ff 70` formats its data as:

```text
name|AA:BB:CC:DD:EE:FF|GG:HH:II:JJ:KK:LL|V1.22_203dpi|serial|batteryPercent
```

Each address group follows the byte order of response `30 12`, in uppercase hex.
Here, `batteryPercent` is decimal ASCII; in `50 f1`, it is binary. The string does
not escape `|` within the saved serial number, and the string setter allows that
character. Six fields are therefore guaranteed only for ordinary factory strings
without the separator.

### Print settings: `10 ff 10 s n`

| `s`  | Valid `n` | Stored value                                                         | Saving            |
| ---- | --------- | -------------------------------------------------------------------- | ----------------- |
| `00` | `0..2`    | Raw density, `RAM 0x25fb0`; recalculates heating tables when changed | No immediate call |
| `01` | `0..2`    | Speed cap `15, 25, 35`, respectively, at `RAM 0x25fa8`               | Yes               |
| `02` | `0..5`    | Raw parameter at `RAM 0x2602b`, purpose unknown                      | No immediate call |

Other `n` values produce `ER`. All 256 density argument values were checked by
executing the dispatcher and handler. Response `11` returns the stored speed cap,
for example hex `19` for 25, not index `01`. The third byte of `11` is
`RAM 0x25fb8`, the flag that controls the action of a standalone `0c`.

Factory initialization at `@0x5544` sets, among other values: density 1, speed cap
**24** (which matches none of the setter's three values), `paperFlag=1`, thresholds
1050 and 350, auto-off 20, `RAM 0x26027=1`, and `RAM 0x26029=32`. These are the
reset function's values, not the confirmed current state of a physical printer.

The save routine at `@0x84c8` writes the shared 208-byte configuration area from
`RAM 0x25f90` to flash at `0x01070000`. “No immediate call” therefore does not mean
“never saved”: a later save triggered by another command may persist the changed
field.

PWM parameter `06` stores any low byte, but application through `@0x8c24` caps it
at 99. The value returned by `c0 01` may therefore differ from the applied value.
The physical purpose of this PWM is not fully established. There is no basis for
using it as another “density” command.

For `12`, the auto-off code at `@0x8e80` multiplies the value by 60 and compares it
with an idle counter; `0` disables the condition. The likely unit is minutes, but
this specification does not confirm the counter's update frequency.

### Diagnostics, battery, and sensors

| Query                    | Response                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| `10 ff 0e 00`            | Threshold at `RAM 0x25fc4`, `u16be`                                                          |
| `10 ff 0e 01`            | Threshold at `RAM 0x25fc6`, `u16be`                                                          |
| `10 ff 0e f0`            | Low 16 bits of diagnostic value `RAM 0x20090`, big-endian                                    |
| `10 ff 0e f1`            | Low 16 bits of diagnostic value `RAM 0x20094`, big-endian                                    |
| `10 ff 0e` + another `s` | Two bytes from an uninitialized stack area, **including `s=04`**                             |
| `10 ff 50 f1`            | Estimated battery percentage, `u16be`, function `@0x2088`                                    |
| `10 ff 50 f2`            | `u16be(RAM.u16[0x20120] >> 3)`                                                               |
| `10 ff c0 00`            | `00` and boolean `(@0x1060() == 1)`; likely a charging indicator filtered through two inputs |
| `10 ff c0 01`            | Saved PWM byte at `RAM 0x26026`, extended to `u32be`                                         |
| `10 ff c0 02`            | Raw byte at `RAM 0x26029`                                                                    |

Unknown `50` and `c0` subcommands produce no response.

Battery percentage is calculated from `v=RAM.u32[0x200bc]`: it returns 100 when
the full-charge flag `RAM[0x26054]==1`, 1 when `v≤350`, 99 when `v≥405`, and the
integer part of `100*(v-350)/55` otherwise. This is an estimate from an internal
value, not a measurement of remaining capacity. The function does not return 0
for a normal state.

**`50 f2` is not an established battery voltage query.** The print timer at
`@0x665a` writes `RAM 0x20120` based on the distance between paper sensor
transitions. Dividing by 8 is consistent with converting 203 dpi steps to
millimeters, but the physical unit and exact name of the measured interval require
verification.

**The tail of response `10 ff 01` must not be described as two reliable
measurements.** `@0x42e8` produces three `u32be` values: the threshold from RAM,
input register R2, and input R1. The calling branch at `@0x4fe4` does not set the
last two arguments. Their values depend on preceding read code and do not form a
stable sensor format. This effect was reproduced separately with different preset
values of R1 and R2.

For `03`, the calibrator's return code is mapped as follows: `0 → OK`,
`-1 → ER1` (device already busy), `-2 → ER2` (calibration fault branch), and
`-3 → ER3` (insufficient measurement range). Success requires an internal measured
range greater than 125; the new threshold is saved to `RAM 0x25fc6`. A more precise
physical interpretation of `ER2/ER3` has not been established without the board.

### `10 ff 40` state bitmask

| Bit      | Exact condition for setting it                 | Interpretation                                                              |
| -------- | ---------------------------------------------- | --------------------------------------------------------------------------- |
| 0 (`01`) | `@0x4654() == 0`, i.e. `RAM.u32[0x20128] != 0` | Printing/calibration/handler error; not a universal “data queued” indicator |
| 1 (`02`) | `@0x0c4c() == 0`                               | Sensor state, likely an open cover; ADC channel 2 and threshold 512         |
| 2 (`04`) | `@0x0c80() == 2`                               | Paper-out sensor state                                                      |
| 3 (`08`) | `@0x4654() != 0` and `@0x1f2c(1) == 2`         | Low battery; this branch is checked only when the print state is zero       |
| 4 (`10`) | `@0x7c50() != 0`, i.e. `RAM.u32[0x2606c] != 0` | Temperature interlock                                                       |
| 5–7      | Not set by this function                       | Zero                                                                        |

`@0x49a0` sets the temperature flag above a calculated temperature of 70 and clears
it below 65, with time filtering. `@0x0a94` converts the ADC 1 reading to this scale
using a table. Physical temperature calibration and sensor positions have not
been checked here. The cover indicator is also filtered over successive readings,
so it is not an instantaneous raw input level.

### Diagnostic transformation `10 ff ff n`

```text
hi = n >> 4
lo = n & 0x0f
reply = ((hi | lo) << 4) | (hi & lo)
```

Examples: `a5 → f0`, `3c → f0`, `ff → ff`. The formula was verified for all 256
byte values. It is not a checksum of the whole job or evidence of authentication.

## 6. Uncompressed raster `GS v 0`

```text
1d 76 30 m xL xH yL yH DATA
```

| Field             | Meaning                                             |
| ----------------- | --------------------------------------------------- |
| `m`               | `00..03` or ASCII `30..33`                          |
| `x = xL + 256*xH` | Source row width **in bytes**                       |
| `y = yL + 256*yH` | Number of source rows                               |
| `DATA`            | Exactly `x*y` bytes, row by row, without separators |

One bit is one dot; `1` means black, and the most significant bit of a byte is on
the left. The print head is **384 dots / 48 bytes** wide. Modes:

| `m`        | Horizontal | Vertical |
| ---------- | ---------- | -------- |
| `00`, `30` | ×1         | ×1       |
| `01`, `31` | ×2         | ×1       |
| `02`, `32` | ×1         | ×2       |
| `03`, `33` | ×2         | ×2       |

Doubling does not change the input body length of `x*y`. The firmware duplicates
output rows/dots internally. To fit the complete image with zero margin, use
`x≤48` in ×1 modes and `x≤24` in ×2 modes.

The handler at `@0x6c78` clips output beyond the working width but **reads all
bytes of the declared width**. Sending 48 bytes when 49 were declared is invalid:
the 49th byte will still be taken from the stream. Isolated execution checked
normal/vertically doubled modes, ASCII aliases, clipping, and missing data.
Horizontal doubling was traced statically; it uses a bit-band alias not modeled
by this test harness.

Alignment comes from `ESC a`. Let `W=8*x`, or `16*x` with doubling,
`cursor=RAM.u32[0x20008]`, and `margin=RAM.u32[0x20040]`:

- Left: start at `cursor`.
- Center: `(384-W+margin)/2` if `W+margin<384`, otherwise 0.
- Right: `384-W` if `W<384`, otherwise 0.

Without horizontal doubling, the start position is additionally divided by 8,
discarding the remainder: positioning is effectively byte-aligned. The ×2 modes
use bit-level placement. Extreme combinations of a nonzero margin and an overwide
doubled raster have not been confirmed correct; normalized input within 384 dots
avoids this ambiguity.

Implementation edge cases:

- `y=0` produces no rows; `x=0, y>0` produces blank rows.
- An invalid `m` is detected **after reading the dimensions**. The body is not
  drained and may become subsequent commands/text.
- If a required body byte is missing, `@0xa0e8` returns a value >255: the handler
  sets `RAM.u32[0x20128]=4` and exits without publishing the incomplete row.
  Already published rows are not rolled back.
- Draining the clipped portion uses a different reader with different timeout
  handling. The header also lacks a shared check for all timeouts.
- At the start, the handler waits for input data to accumulate when ring occupancy
  is low. This is a separate buffering heuristic, not another BLE packet size rule.
- The `GS v` branch calls the speed limiter with a value of 24 before even checking
  the following `30` byte (`@0x28f0`).

Minimal valid body example: two rows of two bytes, 16×2 dots:

```text
1d 76 30 00 02 00 02 00 80 01 ff 00
                         └ DATA ───┘
```

This is only the image command; print permission and end-of-job handling are
covered in section 9. For checking bit packing, the image itself contains three
ready-made `GS v 0` commands at offsets `0xe0c6`, `0xeeae`, and `0xf1e6`
(384×74, 384×17, 384×17).

## 7. Compressed raster `1f 00`

A separate main-loop path, `@0x9788 → @0x1ddc`:

```text
1f 00 X:u16be Y:u16be N:u32be COMPRESSED
```

`X` is the uncompressed row width in bytes. `Y` is the declared height.
`N` is the declared compressed body length. Unlike `GS v 0`, multibyte fields here
are **big-endian**.

The firmware supplies the decoder with two bytes, `28 91`, then feeds incoming
bytes one by one. The verified `COMPRESSED` format is a **zlib stream with a
1024-byte window and its first two header bytes removed**. The trailing Adler-32
is retained. This is not PNG/JPEG or a complete zlib stream with its header sent
again.

Reproducible generator for the verified variant:

```python
import struct
import zlib

width_bytes, height = 2, 3
pixels = bytes.fromhex("80 01 55 aa ff 00")
compressor = zlib.compressobj(wbits=10)
z = compressor.compress(pixels) + compressor.flush()
assert z[:2] == bytes.fromhex("28 91")
body = z[2:]
command = b"\x1f\x00" + struct.pack(">HHI", width_bytes, height, len(body)) + body
```

Decoding these bytes with **the actual V1.22 code** produced three rows ending in
`80 01`, `55 aa`, and `ff 00`. The allocator, row queue, and peripherals were
replaced; the decoder itself and callback `@0x1ee8` were executed from the image.

Placement differs from the uncompressed raster: the row always starts at
`max(48-X, 0)` bytes, so a narrow image is right-aligned regardless of `ESC a`.
Every `X` uncompressed bytes publish a row with tag `3e`. Bytes beyond the right
boundary of 48 are not written to the row.

Significant limitations confirmed by code and control examples:

- `Y` is used to calculate a compression ratio/speed factor but does not stop row
  output. The same stream with `Y=1` still produced three rows.
- The counter compared with `N` is initialized to zero and never incremented in
  the loop. For **any positive `N`**, reading continues until the decoder finishes,
  fails, or times out. An example with `N=1` read the entire 12-byte body.
- With `N=0`, the body-reading loop does not run. This is not a useful way to send
  an image of unknown length.
- An incomplete/invalid stream may already have published some rows. Decoder
  errors have a branch that publishes a partial row; timeouts take a different path.
- The main loop does not convert return values `0`, `-1`, or decoder error codes
  into an `FF01` response. The absence of a BLE error does not confirm successful
  decompression.

Clients must perform their own checks for `X>0`, dimensions, expected uncompressed
size, and stream integrity. Ordinary `GS v 0` has a simpler body boundary. Full
compatibility with all DEFLATE variants and sustained printing through `1f 00`
have not been tested on hardware.

## 8. Text, paper feed, and QR

This is a limited subset of commands that resemble ESC/POS. The presence of
`ESC`/`GS` prefixes does not imply support for other commands in that standard.

| Command            | V1.22 behavior                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `0a` — LF          | Align accumulated text, publish the row, and advance to the next                          |
| `0c` — FF          | If `paperFlag != 0`: four blank rows and a page-boundary search marker; otherwise nothing |
| `0d` — CR          | Ignored                                                                                   |
| `1b 20 n` — ESC SP | Character spacing at `RAM 0x20030`                                                        |
| `1b 21 n` — ESC !  | Bit 5: width ×2; bit 4: height ×2; bits 7 and 3 set additional text flags                 |
| `1b 33 n` — ESC 3  | Line spacing at `RAM 0x20028`; initial value 30                                           |
| `1b 47 n` — ESC G  | The low bit sets the same text flag as bit 3 of `ESC !`                                   |
| `1b 4a n` — ESC J  | Feed `n` blank rows through `@0x6b64`                                                     |
| `1b 56 n` — ESC V  | `0..3` / ASCII `0..3`: text angle 0°, 90°, 180°, 270°; other values leave it unchanged    |
| `1b 61 n` — ESC a  | `0..2` / ASCII `0..2`: left, center, right                                                |
| `1b 40` — ESC @    | **No reset**: the unknown branch returns without resetting parameters                     |
| `1c` — FS          | Ignored as a single byte; does not consume the next character                             |
| `1d 0c` — GS FF    | Four blank rows and a page search marker regardless of `paperFlag`                        |
| `1d 21 n` — GS !   | Width `min((n>>4)+1,2)`, height `min((n&15)+1,2)`                                         |
| `1d 2f` — GS /     | Does nothing in this branch and reads no additional argument                              |
| `1d 72 n` — GS r   | Reads and discards one byte; **does not return status**                                   |
| `1d 76 30 …`       | Uncompressed raster from section 6                                                        |
| `1d 6c …`          | QR from the next subsection                                                               |
| `1f b2 n`          | Reads and discards one byte; no further action found                                      |
| `1b 10 …`          | Maintenance frame; only after enabling the mode, section 10                               |

Text path: `@0x69d4`, glyph preparation at `@0x808c`, publishing at `@0x5464`.
Ordinary characters use the resource at `@0xf51e`, with a 72-byte stride, a base
logical width of 12 dots, and a height of 24 dots. Text accumulates until LF or
wrapping past the width. Characters `<0x20` that are not handled as separate
commands are not printed; this explains why zero padding after `fe 01` does nothing.
The complete code page for extended characters is unknown. This description does
not establish direct UTF-8/Cyrillic support; use a raster for those characters.

### QR: `1d 6c`

```text
1d 6c scale ecc lenL lenH DATA
```

The handler at `@0x291c` accepts:

- `scale=0..12`. Zero passes the initial check but is not a useful print size;
  generating an image requires positive values.
- `ecc=0..4` or ASCII `30..34`; after normalization, `0/1→0`, `2→1`, `3→2`,
  `4→3`. These are four internal correction levels; this analysis does not
  separately establish their mapping to L/M/Q/H.
- Length `len` is `u16le`. A significant difference: it is **clamped to 128 before
  reading**. If 200 is declared, only 128 bytes are read; the rest become commands.

An invalid `scale` stops processing before the remaining fields are read; an
invalid `ecc` stops it before reading the length. Text/binary content goes to the
internal QR encoder at `@0x2f14`, and the result to the rasterizer at `@0x7fa8`.
It centers the QR code using its own formula and the current cursor; `ESC a` is
not its general alignment control. There is no `FF01` response.

## 9. Print jobs and the meaning of `AA`, `OK`, and `RE`

The stream passes through three queues:

```text
FF02 writes
    → receive ring buffer: 8192 bytes
    → parser / raster / text / QR
    → 48-row ring buffer: 48 bytes of dots + 1 control byte per row
    → 24-entry queue, up to 6 phases per entry
    → timer / motor / print head
```

Credits apply to the first queue. Free input bytes do not mean the last row has
already been physically printed.

### Start: `10 ff fe 01`

Sets `RAM.u8[0x2011a]=1`, without a response. The worker at `@0x8c94` uses this flag
as one of the conditions for starting printing, along with a nonempty queue and
no blocking state. The command does not reset all settings or require 12 additional
zeros. Its handler does not consume those zeros.

### Next-page search: `0c` / `1d 0c`

After four feed rows, `@0x3950` adds a special row with tag `3d` and sets
`RAM.u8[0x20004]=1`. When the tag reaches the execution queue, the timer at
`@0x65d4` starts a paper-boundary search through `@0x67f0`. A successful transition
to state 5 sets `RAM.u8[0x20109]=1`.

This is a separate mechanical operation. An ordinary raster block has tag `3e`,
text `3f`, blank feed `3c`, and QR `38`. These tags exist only in internal queues;
they must not be sent as separate bytes over BLE.

### End: `10 ff fe 45`

The handler at `@0x6504` does the following:

```text
RAM[0x20003] = 1  # end marker encountered
if RAM[0x20004] != 0:
    RAM[0x20004] = 0
    no immediate response
else:
    FF01 ← aa
```

Thus, `AA` is a **direct response from the marker branch**, without waiting for all
queues to drain or the motor to stop. It must not be called “printing complete”.

When the row consumer sees an empty current slot, it calls `@0xa11c`. This function
also requires `RAM.u32[0x20128]==0` and an empty phase queue, then:

| Condition                                              | Action                            |
| ------------------------------------------------------ | --------------------------------- |
| `RAM[0x20109] == 1`                                    | Clear the flag; `FF01 ← OK`       |
| Otherwise, `RAM[0x2010a] == 1` and `RAM[0x20003] == 1` | Clear the first flag; `FF01 ← RE` |
| Otherwise                                              | No response                       |

`OK` is associated with a recorded successful page search and drained execution
queues; this branch does not require `fe 45`. For `RE`, the send condition is
confirmed, but the source that sets `RAM 0x2010a` and the branch's reachability
during ordinary BLE printing are unknown. It is **not a proven universal “out of
paper” or “print error” code**. All listed response conditions were checked in
isolation; forcing a flag in a test does not establish its reachability on a device.

The next top-level byte after `fe 45` passes through `@0x4350`, which clears both
the end flag at `0x20003` and start permission at `0x2011a`. A subsequent status
query is therefore not neutral to this state machine. Arbitrary polling after
`fe 45` cannot be treated as an unconditional completion barrier. Job state,
queues, and the next `fe 01` must be taken into account.

### Ordinary raster job sequence

The following example shows the command order implied by the code; it was not
physically tested on V1.22 in this work:

```text
BLE: subscribe to FF01 and FF03, receive initial credits
FF02 → 10 ff 20 f1                         # version query
FF01 ← ASCII "V1.22_203dpi"
FF02 → 10 ff 10 00 01                      # raw density=1
FF01 ← 4f 4b
FF02 → 10 ff fe 01                         # allow startup
FF02 → 1b 61 00                            # left alignment
FF02 → 1d 76 30 00 30 00 hL hH DATA        # 48*h bytes
FF02 → 1b 4a n                             # optional feed
FF02 → 10 ff fe 45                         # end marker
FF01 ← aa                                 # if no page marker was queued
```

Each FF02 arrow denotes a logical command, not a requirement for a single ATT write.
Large `DATA` bodies are split into BLE-compatible chunks with credit accounting.
For labels, a separate `0c`/`1d 0c` before the end changes behavior as described above.

### Density and dependence on row coverage

The function at `@0x7ad4` maps raw levels `0,1,2` to factors `65,110,155`, then uses
an additional table multiplier. A single factor cannot guarantee the physical
darkness ordering on another printer revision.

The function at `@0x4ae4` sums weights for the row's 48 bytes using the table at
`@0x13000`. For a nonempty row, `(sum-1)>>6` selects one of six handlers through
`@0x13134`: `0x7d7c`, `0x7db0`, `0x7df4`, `0x7e50`, `0x7ea4`, `0x7f10`.
They create 1–6 masked subrows; the two-phase variant uses `55/aa`. A solid black
row yields a sum of 384 and six phases. This explains why execution internally
depends on row coverage without additional BLE commands.

The table differs from an exact popcount in one place: byte `f4` has weight 7,
although it contains five set bits. The reason is unknown. Neither this anomaly
nor the phase count can be linked to a specific physical print defect without
measurement.

## 10. Maintenance frames and updates over the same BLE stream

In the BLE branch, `10 ff e0 aa aa` and `10 ff ee aa aa` set the flag
`RAM.u8[0x200e0]=1`. After that, `ESC 10` is processed as a frame:

```text
1b 10 L:u16be outer0 outer1 BODY[L] CHECKSUM:u8
```

The total length is `L+7`. `CHECKSUM` is the sum of **all preceding frame bytes
modulo 256**, including `1b 10`, the length, and the two outer bytes. It is a simple
sum, not a CRC or signature. The parser at `@0x6778` does not interpret the outer
bytes; the response formatter at `@0x9c48` sets both to zero.

The reader at `@0x648c` is limited to 320 bytes; the validator requires a total
length of **8..320**. A total-length/prefix/checksum error disables maintenance
mode. A response is constructed with error byte `02`, but errors in the header
itself leave some response context fields without guaranteed values.

The inner body is parsed by `@0x2ac4`:

```text
cmd:u8 kind:u8 reserved0:u8 reserved1:u8 P:u16be PAYLOAD[P]
```

The handler limits `P≤300`. The outer and inner lengths are not checked for
consistency. A correctly formed request must have `L=6+P` and total length `13+P`;
the maximum at `P=300` is 313 bytes. Responses use `kind=01` and zero reserved
bytes. These frames can be split across BLE writes at the transport layer; that
does not increase the frame buffer size.

Complete identification example after enabling the mode, verified by executing
the reader → validator → router → formatter chain:

```text
request:  1b 10 00 06 00 00 01 00 00 00 00 00 32
response: 1b 10 00 0f 00 00 02 01 00 00 00 09 00 50 52 3a 41 36 5f 53 44 8f
```

Internal router at `@0x2b3e`:

| `cmd`              | Request payload                             | Action / response payload                                                                        |
| ------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `01`, `02`         | Not used by the handler                     | Response with `cmd=02`, `00` + ASCII `PR:A6_SD` (9 bytes)                                        |
| `03`               | `type:u8 start:u32be end:u32be`             | For `type=0`, prepare the update area; respond with one raw result code. Other types return `03` |
| `04`               | `type:u8 index:u32be size:u16be data[size]` | For `type=0`, write a block; respond with one raw code. Other types return `03`                  |
| `06`               | `type:u8 a:u32be b:u32be`                   | Response `00 + sum:u32be`; for `type=0`, the byte sum of the prepared range, otherwise zero      |
| `07`               | Not used by the handler                     | Set a boot flag, save maintenance data/configuration, and trigger a reset                        |
| `00`, `05`, others | Not used                                    | No dedicated handler/normal response found                                                       |

Details established without executing these operations on the device:

- Preparation at `@0x52b8` uses the fixed flash start `0x01048000`, length
  `end-start`, resets the block index, and calls an erase of an area of size
  `0x20000`. Supplied start/end values do not become arbitrary write addresses.
- Writing at `@0x5274` requires `index` to match the expected counter and both the
  current address and size to be multiples of four. An index mismatch returns
  `07`; an alignment mismatch returns `04`, disabling maintenance mode. After the
  write call, it increments the address by `size`, the index by one, and returns
  `00`.
- `@0x525c` does sum the bytes of the already prepared range; the supplied `a/b`
  fields are not used inside this function. This is not established cryptographic
  image integrity verification.
- The handlers do not verify that all nested sizes fit within the outer frame.
  They must not be relied on to validate input packets.
- The ROM portion that applies the update and hardware compatibility of images
  were not reconstructed here. This section records the protocol structure and
  side effects, rather than providing a verified flashing procedure.

A production client must keep this mode separate from ordinary information
queries: its commands `03/04/07` change flash and boot state. They were not sent to
the printer during this research.

## 11. Reproduction and evidence map

Tools are pinned by the existing `flake.lock`, nixpkgs revision
`419fe0f449b3fbe3bdd53d9840288db4509ec32e`. Disassembly uses Python with Capstone;
checks use Unicorn 2.1.4. The tools are in the separate `firmware` dev shell defined
in [flake.nix](../flake.nix).

Research scripts, the original image, full listings, and JSON files are in
`storage/firmware/`, which is excluded from Git. This document is self-contained:
local artifact links require the retained directory, but the image hash, formats,
and reference offsets are included in the text.

```sh
nix develop .#firmware -c python3 storage/firmware/analyze_v122.py
nix develop .#firmware -c python3 storage/firmware/verify_protocol_v122.py
nix develop .#firmware -c python3 storage/firmware/analyze_v122.py --slice 0x4ec8 0x5208
```

| Area                              | Offsets in the original image                                     |
| --------------------------------- | ----------------------------------------------------------------- |
| Initial RAM/GATT structures       | Load table `0x138c8`, compressed data `0x138e8`, decoder `0x0a3e` |
| BLE registration, advertising     | `0x2236–0x247c`                                                   |
| FF02 reception, FF03 subscription | `0x1714–0x1814`                                                   |
| Credits, ring buffer              | `0x16ec`, `0x81a8`, `0xa200`, `0xa2b0`, `0xafe8–0xb0ac`           |
| Main parser / vendor router       | `0x9764`, `0x4350`, `0x275c`, `0x4ec8`                            |
| FF01 responses                    | `0x2570`, `0x25d8`, `0x2630`                                      |
| Version, identification, settings | `0x7b58`, `0x20d0`, `0x404c`, `0x55e0`, `0x84c8`                  |
| Status and sensors                | `0x4420`, `0x0c4c`, `0x0c80`, `0x1f2c`, `0x49a0`                  |
| Raster and row queue              | `0x6c78`, `0x7050`, `0x81b8`, `0x8210`, `0x6bf8`                  |
| Compressed raster                 | `0x1ddc`, `0x1ee8`, `0xa350–0xa39c`, `0xb394`, `0xb924`           |
| QR                                | `0x291c`, `0x2f14`, `0x7fa8`                                      |
| Markers and completion            | `0x3950`, `0x6504`, `0x65d4`, `0x67f0`, `0x852c`, `0xa11c`        |
| Phase queue and print startup     | `0x4ae4`, `0x4b34`, `0x6540`, `0x8c94`, `0x9878`                  |
| Maintenance frames                | `0x648c`, `0x6778`, `0xb718`, `0x2ac4`, `0x2b3e`, `0x9c48`        |

Check results:

- `storage/firmware/analysis-v1.22/protocol-verification.json` — list of 813
  successful cases and the harness's limitations.
- `storage/firmware/analysis-v1.22/protocol-probes.json` — inputs, responses,
  RAM accesses, allowed machine-code regions, and replaced calls.
- `storage/firmware/analysis-v1.22/snippets/` — listings grouped by topic.
- `storage/firmware/analysis-v1.22/protocol-tables.json` — GATT/flow-control/phases.
- `storage/firmware/SHA256SUMS` and `analysis-v1.22/SHA256SUMS` — integrity of the
  saved research artifacts.

The 813 cases include 256 dispatch checks, 256 density checks, 256 nibble
transformation checks, auto-off boundaries, parameter truncation, identification,
the undefined tail of `01`, markers and responses, raster clipping/missing data,
unsupported `ESC @`/`GS r`, BLE thresholds and overflow, decompression with
inconsistent `Y/N`, maintenance frame boundaries/checksum, and a complete maintenance
identification query. These checks do not confirm radio timings, the entire QR
encoder, physical units, or mechanical operation.

## 12. What still needs confirmation

1. The semantics of parameter `02 182`, its relationship to MTU, and SDK response
   fragmentation.
2. The physical purpose of raw fields `10 02`, `80`, `81`, `f8`, and PWM `05/06`;
   units of speed, measurement `50 f2`, and the auto-off timer.
3. Reachability of the `RE` branch and queue behavior during real pauses, paper
   exhaustion, cover opening, and job continuation after `fe 45`.
4. The complete text resource map and QR behavior with edge-case parameters.
5. Sustained compressed image transmission and all DEFLATE stream variants.
6. Applicability to the installed V1.36: this requires its image or targeted device
   measurements, rather than a comparison of version numbers alone.

These gaps do not prevent describing V1.22's core byte-level contract, but they
limit conclusions about physical results and compatibility with other devices.
