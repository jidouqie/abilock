// Independent minimal server fixtures for the published PostgreSQL v3, MySQL
// protocol 4.1, and Redis RESP specifications. They are not database engines.
import net, { type Socket } from "node:net";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

export const FIXTURE_PASSWORD = "synthetic-protocol-password-only";
export type WireFixture = {
  port: number;
  commands: string[];
  authCount: () => number;
  close: () => Promise<void>;
};
async function listen(
  handler: (socket: Socket, commands: string[], auth: () => void) => void,
): Promise<WireFixture> {
  const sockets = new Set<Socket>(),
    commands: string[] = [];
  let authCount = 0;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    handler(socket, commands, () => authCount++);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("FIXTURE_ADDRESS");
  return {
    port: address.port,
    commands,
    authCount: () => authCount,
    close: async () => {
      sockets.forEach((socket) => socket.destroy());
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
const i16 = (value: number) => {
  const bytes = Buffer.alloc(2);
  bytes.writeInt16BE(value);
  return bytes;
};
const i32 = (value: number) => {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32BE(value);
  return bytes;
};
const nul = (value: string) => Buffer.from(value + "\0");
function pgPacket(type: string, payload: Buffer) {
  return Buffer.concat([Buffer.from(type), i32(payload.length + 4), payload]);
}
const PG_DESCRIPTION = Buffer.concat([
  i16(1),
  nul("answer"),
  i32(0),
  i16(0),
  i32(23),
  i16(4),
  i32(-1),
  i16(0),
]);
const PG_ROW = Buffer.concat([i16(1), i32(2), Buffer.from("42")]);
function pgError() {
  return Buffer.concat([
    Buffer.from("S"),
    nul("ERROR"),
    Buffer.from("C"),
    nul("42601"),
    Buffer.from("M"),
    nul("fixture error " + FIXTURE_PASSWORD),
    Buffer.from([0]),
  ]);
}

export async function postgresFixture() {
  return listen((socket, commands, auth) => {
    let buffer = Buffer.alloc(0),
      startup = true,
      authenticated = false,
      prepared = "";
    const send = (type: string, payload = Buffer.alloc(0)) =>
      socket.write(pgPacket(type, payload));
    const finish = () => send("Z", Buffer.from("I"));
    const rows = (query: string, description = true) => {
      if (query.includes("FAIL_FIXTURE")) {
        send("E", pgError());
        return;
      }
      if (query.includes("STALL_FIXTURE")) return;
      if (query.includes("LARGE_FIXTURE")) {
        const field = Buffer.from(PG_DESCRIPTION);
        field.writeInt32BE(25, 2 + 7 + 4 + 2);
        field.writeInt16BE(-1, 2 + 7 + 4 + 2 + 4);
        const bytes = Buffer.alloc(12 * 1024 * 1024, '"');
        send("T", field);
        send("D", Buffer.concat([i16(1), i32(bytes.length), bytes]));
        send("C", nul("SELECT 1"));
        return;
      }
      if (/^\s*(?:UPDATE|INSERT|DELETE|CREATE|BEGIN|COMMIT)/i.test(query))
        send("C", nul("UPDATE 1"));
      else {
        if (description) send("T", PG_DESCRIPTION);
        send("D", PG_ROW);
        send("C", nul("SELECT 1"));
      }
    };
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= (startup ? 4 : 5)) {
        const length = buffer.readInt32BE(startup ? 0 : 1),
          total = startup ? length : length + 1;
        if (buffer.length < total) break;
        const packet = buffer.subarray(0, total);
        buffer = buffer.subarray(total);
        if (startup) {
          if (length === 8 && packet.readInt32BE(4) === 80877103) {
            socket.write("N");
            continue;
          }
          assert.equal(packet.readInt32BE(4), 196608);
          assert.match(packet.subarray(8).toString(), /user\0fixture-user\0/);
          assert.match(packet.subarray(8).toString(), /database\0fixture-db\0/);
          startup = false;
          send("R", i32(3));
          continue;
        }
        const type = String.fromCharCode(packet[0]),
          payload = packet.subarray(5);
        if (type === "p") {
          if (payload.toString() !== FIXTURE_PASSWORD + "\0") {
            send("E", pgError());
            socket.end();
            continue;
          }
          authenticated = true;
          auth();
          send("R", i32(0));
          send("S", Buffer.concat([nul("server_version"), nul("18.0")]));
          send("S", Buffer.concat([nul("client_encoding"), nul("UTF8")]));
          finish();
        } else if (type === "X") socket.end();
        else {
          assert.equal(authenticated, true);
          if (type === "Q") {
            const query = payload.subarray(0, -1).toString();
            commands.push(query);
            rows(query);
            if (!query.includes("STALL_FIXTURE")) finish();
          } else if (type === "P") {
            const statementEnd = payload.indexOf(0),
              sqlEnd = payload.indexOf(0, statementEnd + 1);
            prepared = payload.subarray(statementEnd + 1, sqlEnd).toString();
            commands.push(prepared);
            send("1");
          } else if (type === "B") {
            let offset = payload.indexOf(0) + 1;
            offset = payload.indexOf(0, offset) + 1;
            const formatCount = payload.readInt16BE(offset);
            offset += 2 + formatCount * 2;
            assert.equal(payload.readInt16BE(offset), 1);
            offset += 2;
            const parameterLength = payload.readInt32BE(offset);
            offset += 4;
            assert.equal(
              payload.subarray(offset, offset + parameterLength).toString(),
              "42",
            );
            send("2");
          } else if (type === "D") send("T", PG_DESCRIPTION);
          else if (type === "E") rows(prepared, false);
          else if (type === "S") finish();
          else if (type === "H") {
            /* Flush has no response. */
          } else throw new Error("FIXTURE_PG_MESSAGE_" + type);
        }
      }
    });
  });
}

const little = (value: number, length: 2 | 4) => {
  const bytes = Buffer.alloc(length);
  if (length === 2) bytes.writeUInt16LE(value);
  else bytes.writeUInt32LE(value);
  return bytes;
};
const lengthString = (value: string) => {
  const bytes = Buffer.from(value);
  assert.ok(bytes.length < 251);
  return Buffer.concat([Buffer.from([bytes.length]), bytes]);
};
function mysqlPacket(sequence: number, payload: Buffer) {
  const header = Buffer.alloc(4);
  header.writeUIntLE(payload.length, 0, 3);
  header[3] = sequence;
  return Buffer.concat([header, payload]);
}
const MYSQL_CAPABILITIES = 0x000ba20d;
const MYSQL_SALT = Buffer.from("12345678901234567890");
const MYSQL_EOF = Buffer.from([0xfe, 0, 0, 2, 0]);
const MYSQL_OK = Buffer.from([0, 0, 0, 2, 0, 0, 0]);
const MYSQL_FIELD = Buffer.concat([
  lengthString("def"),
  lengthString("fixture-db"),
  lengthString(""),
  lengthString(""),
  lengthString("answer"),
  lengthString(""),
  Buffer.from([0x0c]),
  little(45, 2),
  little(11, 4),
  Buffer.from([3]),
  little(0, 2),
  Buffer.from([0, 0, 0]),
]);
function nativePassword(password: string) {
  const first = createHash("sha1").update(password).digest(),
    second = createHash("sha1").update(first).digest(),
    challenge = createHash("sha1")
      .update(Buffer.concat([MYSQL_SALT, second]))
      .digest();
  return Buffer.from(first.map((byte, index) => byte ^ challenge[index]));
}
export async function mysqlFixture(
  infilePath = "/not-a-real-vault/admin-auth.json",
) {
  return listen((socket, commands, auth) => {
    let buffer = Buffer.alloc(0),
      authenticated = false,
      infileRequest = false;
    const greeting = Buffer.concat([
      Buffer.from([10]),
      nul("8.4.0-fixture"),
      little(1, 4),
      MYSQL_SALT.subarray(0, 8),
      Buffer.from([0]),
      little(MYSQL_CAPABILITIES & 65535, 2),
      Buffer.from([45]),
      little(2, 2),
      little(MYSQL_CAPABILITIES >>> 16, 2),
      Buffer.from([21]),
      Buffer.alloc(10),
      MYSQL_SALT.subarray(8),
      Buffer.from([0]),
      nul("mysql_native_password"),
    ]);
    socket.write(mysqlPacket(0, greeting));
    const send = (sequence: number, payload: Buffer) =>
      socket.write(mysqlPacket(sequence, payload));
    const rows = (binary = false) => {
      send(1, Buffer.from([1]));
      send(2, MYSQL_FIELD);
      send(3, MYSQL_EOF);
      send(
        4,
        binary
          ? Buffer.concat([Buffer.from([0, 0]), little(42, 4)])
          : lengthString("42"),
      );
      send(5, MYSQL_EOF);
    };
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUIntLE(0, 3);
        if (buffer.length < length + 4) break;
        const packet = buffer.subarray(4, length + 4);
        buffer = buffer.subarray(length + 4);
        if (infileRequest) {
          assert.equal(
            packet.length,
            0,
            "unsolicited LOCAL INFILE must return zero file bytes",
          );
          infileRequest = false;
          send(3, MYSQL_OK);
          continue;
        }
        if (!authenticated) {
          const usernameEnd = packet.indexOf(0, 32),
            username = packet.subarray(32, usernameEnd).toString(),
            authLength = packet[usernameEnd + 1];
          assert.equal(username, "fixture-user");
          if (
            !packet
              .subarray(usernameEnd + 2, usernameEnd + 2 + authLength)
              .equals(nativePassword(FIXTURE_PASSWORD))
          ) {
            send(
              2,
              Buffer.concat([
                Buffer.from([0xff]),
                little(1045, 2),
                Buffer.from("#28000access denied"),
              ]),
            );
            socket.end();
            continue;
          }
          const dbStart = usernameEnd + 2 + authLength,
            dbEnd = packet.indexOf(0, dbStart);
          assert.equal(
            packet.subarray(dbStart, dbEnd).toString(),
            "fixture-db",
          );
          authenticated = true;
          auth();
          send(2, MYSQL_OK);
          continue;
        }
        const command = packet[0];
        if (command === 1) socket.end();
        else if (command === 3) {
          const query = packet.subarray(1).toString();
          commands.push(query);
          if (query.includes("FAIL_FIXTURE"))
            send(
              1,
              Buffer.concat([
                Buffer.from([0xff]),
                little(1064, 2),
                Buffer.from("#42000fixture error " + FIXTURE_PASSWORD),
              ]),
            );
          else if (query.includes("INFILE_ATTACK")) {
            infileRequest = true;
            send(
              1,
              Buffer.concat([Buffer.from([0xfb]), Buffer.from(infilePath)]),
            );
          } else if (query.includes("LARGE_FIXTURE")) {
            send(1, Buffer.from([1]));
            const field = Buffer.from(MYSQL_FIELD);
            field[field.length - 6] = 253;
            send(2, field);
            send(3, MYSQL_EOF);
            const bytes = Buffer.alloc(12 * 1024 * 1024, '"'),
              header = Buffer.alloc(4);
            header[0] = 253;
            header.writeUIntLE(bytes.length, 1, 3);
            send(4, Buffer.concat([header, bytes]));
            send(5, MYSQL_EOF);
          } else if (query.includes("STALL_FIXTURE")) {
            /* Deliberately hold the connection. */
          } else if (
            /^\s*(?:UPDATE|INSERT|DELETE|CREATE|BEGIN|COMMIT)/i.test(query)
          )
            send(1, Buffer.from([0, 1, 0, 2, 0, 0, 0]));
          else rows();
        } else if (command === 0x16) {
          commands.push(packet.subarray(1).toString());
          send(
            1,
            Buffer.concat([
              Buffer.from([0]),
              little(1, 4),
              little(1, 2),
              little(1, 2),
              Buffer.from([0]),
              little(0, 2),
            ]),
          );
          send(2, MYSQL_FIELD);
          send(3, MYSQL_EOF);
          send(4, MYSQL_FIELD);
          send(5, MYSQL_EOF);
        } else if (command === 0x17) {
          assert.equal(packet.readUInt32LE(1), 1);
          assert.equal(packet[11], 1);
          assert.ok([3, 5].includes(packet[12]));
          assert.equal(
            packet[12] === 3 ? packet.readInt32LE(14) : packet.readDoubleLE(14),
            42,
          );
          rows(true);
        } else if (command === 0x19) {
          /* COM_STMT_CLOSE has no response. */
        } else throw new Error("FIXTURE_MYSQL_COMMAND");
      }
    });
  });
}

function respCommand(
  buffer: Buffer,
): { args: Buffer[]; length: number } | undefined {
  let end = buffer.indexOf("\r\n");
  if (end < 0) return;
  assert.equal(buffer[0], 42);
  const count = Number(buffer.subarray(1, end).toString());
  let offset = end + 2;
  const args: Buffer[] = [];
  for (let index = 0; index < count; index++) {
    end = buffer.indexOf("\r\n", offset);
    if (end < 0) return;
    assert.equal(buffer[offset], 36);
    const length = Number(buffer.subarray(offset + 1, end).toString());
    if (buffer.length < end + 2 + length + 2) return;
    args.push(buffer.subarray(end + 2, end + 2 + length));
    offset = end + 2 + length + 2;
  }
  return { args, length: offset };
}
function bulk(value: string | Buffer) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([
    Buffer.from("$" + bytes.length + "\r\n"),
    bytes,
    Buffer.from("\r\n"),
  ]);
}
export async function redisFixture() {
  const values = new Map<string, Buffer>();
  return listen((socket, commands, auth) => {
    let buffer = Buffer.alloc(0),
      authenticated = false;
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length && buffer[0] !== 42) {
        socket.destroy();
        return;
      }
      while (buffer.length) {
        const parsed = respCommand(buffer);
        if (!parsed) break;
        buffer = buffer.subarray(parsed.length);
        const command = parsed.args[0].toString(),
          args = parsed.args.slice(1);
        if (command === "AUTH") {
          if (args.at(-1)?.toString() !== FIXTURE_PASSWORD) {
            socket.write("-WRONGPASS invalid credentials\r\n");
          } else {
            authenticated = true;
            auth();
            socket.write("+OK\r\n");
          }
        } else if (command === "HELLO") {
          assert.equal(args[0].toString(), "3");
          if (
            args[1]?.toString() !== "AUTH" ||
            args[3]?.toString() !== FIXTURE_PASSWORD
          )
            socket.write("-WRONGPASS invalid credentials\r\n");
          else {
            authenticated = true;
            auth();
            socket.write(
              "%7\r\n+server\r\n+redis\r\n+version\r\n+8.0.0\r\n+proto\r\n:3\r\n+id\r\n:1\r\n+mode\r\n+standalone\r\n+role\r\n+master\r\n+modules\r\n*0\r\n",
            );
          }
        } else if (command === "CLIENT" && args[0].toString() === "SETINFO")
          socket.write("+OK\r\n");
        else if (command === "SELECT") {
          assert.equal(authenticated, true);
          socket.write("+OK\r\n");
        } else {
          if (!authenticated) {
            socket.write("-NOAUTH authentication required\r\n");
            continue;
          }
          commands.push(parsed.args.map((item) => item.toString()).join(" "));
          if (command === "PING") socket.write("+PONG\r\n");
          else if (command === "ECHO") socket.write(bulk(args[0]));
          else if (command === "SET") {
            values.set(args[0].toString(), args[1]);
            socket.write("+OK\r\n");
          } else if (command === "GET") {
            const key = args[0].toString();
            if (key === "FAIL_FIXTURE")
              socket.write("-ERR fixture error " + FIXTURE_PASSWORD + "\r\n");
            else if (key === "STALL_FIXTURE") {
              /* Hold. */
            } else if (key === "LARGE_FIXTURE")
              socket.write(bulk(Buffer.alloc(12 * 1024 * 1024, '"')));
            else
              socket.write(
                values.has(key) ? bulk(values.get(key)!) : "$-1\r\n",
              );
          } else socket.write("-ERR unknown command\r\n");
        }
      }
    });
  });
}
