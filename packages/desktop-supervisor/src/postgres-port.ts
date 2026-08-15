/**
 * Persistent localhost port selection for the private PostgreSQL cluster.
 * Never kill a process merely because a port is occupied.
 */
import net from "node:net";
import {
  PRIVATE_POSTGRES_HOST,
  PRIVATE_POSTGRES_MAJOR,
  PRIVATE_POSTGRES_PREFERRED_PORT,
  type PostgresLayout,
  type PostgresListenMetadata
} from "./postgres-layout.js";

export type PortProbe = {
  occupied: boolean;
  foreign: boolean;
};

export type SelectPrivatePostgresPortInput = {
  layout: PostgresLayout;
  clusterId: string;
  preferredPort?: number | undefined;
  persisted?: PostgresListenMetadata | null | undefined;
  ownedPort?: number | null | undefined;
  isPortOccupied?: ((port: number) => Promise<boolean>) | undefined;
};

export async function selectPrivatePostgresPort(
  input: SelectPrivatePostgresPortInput
): Promise<PostgresListenMetadata> {
  const preferred = input.preferredPort ?? PRIVATE_POSTGRES_PREFERRED_PORT;
  const isOccupied = input.isPortOccupied ?? isLocalPortOccupied;

  if (input.ownedPort && Number.isInteger(input.ownedPort)) {
    return listenRecord(input.clusterId, input.ownedPort);
  }

  if (input.persisted && input.persisted.clusterId === input.clusterId) {
    const occupied = await isOccupied(input.persisted.port);
    if (!occupied) {
      return listenRecord(input.clusterId, input.persisted.port);
    }
    // Occupied and not already proven owned: choose another port.
  }

  const candidates = [preferred];
  if (input.persisted && input.persisted.port !== preferred) {
    candidates.push(input.persisted.port);
  }
  for (let port = preferred + 1; port <= preferred + 64; port += 1) {
    candidates.push(port);
  }

  const seen = new Set<number>();
  for (const port of candidates) {
    if (seen.has(port)) continue;
    seen.add(port);
    if (await isOccupied(port)) continue;
    return listenRecord(input.clusterId, port);
  }

  throw new Error("Unable to allocate a free localhost port for private PostgreSQL.");
}

export function isLocalPortOccupied(port: number, host = PRIVATE_POSTGRES_HOST): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (occupied: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(occupied);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(400, () => finish(false));
  });
}

function listenRecord(clusterId: string, port: number): PostgresListenMetadata {
  return {
    schemaVersion: 1,
    host: PRIVATE_POSTGRES_HOST,
    port,
    clusterId,
    postgresMajor: PRIVATE_POSTGRES_MAJOR
  };
}
