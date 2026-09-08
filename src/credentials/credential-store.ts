export interface ProviderCredentialStore {
  create(credential: unknown): Promise<string>
  get(reference: string): Promise<unknown | undefined>
  set(reference: string, credential: unknown): Promise<void>
  delete(reference: string): Promise<void>
  listReferences(): Promise<string[]>
}

export class MemoryProviderCredentialStore implements ProviderCredentialStore {
  private readonly credentials = new Map<string, unknown>()

  async create(credential: unknown): Promise<string> {
    const reference = crypto.randomUUID()
    this.credentials.set(reference, structuredClone(credential))
    return reference
  }

  async get(reference: string): Promise<unknown | undefined> {
    const credential = this.credentials.get(reference)
    return credential ? structuredClone(credential) : undefined
  }

  async set(reference: string, credential: unknown): Promise<void> {
    if (!this.credentials.has(reference)) throw new Error(`Credential not found: ${reference}`)
    this.credentials.set(reference, structuredClone(credential))
  }

  async delete(reference: string): Promise<void> {
    this.credentials.delete(reference)
  }

  async listReferences(): Promise<string[]> {
    return [...this.credentials.keys()]
  }
}
