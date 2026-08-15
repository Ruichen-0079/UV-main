declare module "pg" {
  export class Client {
    constructor(config: Record<string, unknown>);
    connect(): Promise<void>;
    query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }>;
    end(): Promise<void>;
  }
}
