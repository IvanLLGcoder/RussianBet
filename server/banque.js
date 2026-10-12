// Client de la banque commune (API interne servie par le poker, voir le contrat
// « Économie commune »). Chaque appel renvoie { status, data } pour les réponses 2xx/4xx ;
// une panne réseau, un délai dépassé ou une réponse 5xx lèvent BanqueIndisponible.

export class BanqueIndisponible extends Error {
  constructor(message) {
    super(message);
    this.name = 'BanqueIndisponible';
  }
}

export function creerClientBanque({ url, secret, delaiMs = 5000 }) {
  const base = `${url.replace(/\/+$/, '')}/interne/banque/`;

  async function appel(methode, chemin, corps) {
    let reponse;
    try {
      reponse = await fetch(base + chemin, {
        method: methode,
        headers: {
          Authorization: `Bearer ${secret}`,
          ...(corps ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(corps ? { body: JSON.stringify(corps) } : {}),
        signal: AbortSignal.timeout(delaiMs),
      });
    } catch (error) {
      throw new BanqueIndisponible(`Banque injoignable (${chemin}) : ${error.message}`);
    }
    const data = await reponse.json().catch(() => ({}));
    if (reponse.status >= 500) {
      throw new BanqueIndisponible(`Banque en erreur ${reponse.status} (${chemin}) : ${data.erreur ?? ''}`);
    }
    return { status: reponse.status, data };
  }

  return {
    connexion: (nom, mdp) => appel('POST', 'connexion', { nom, mdp }),
    inscription: (nom, mdp, parrain) => appel('POST', 'inscription', { nom, mdp, parrain: parrain ?? null }),
    // « Toucher » : applique allocation du jour et renflouement si dus.
    compte: (id) => appel('GET', `comptes/${encodeURIComponent(id)}`),
    // Sans « toucher » (classement).
    comptes: (ids) => appel('GET', `comptes?ids=${ids.map(Number).join(',')}`),
    // Idempotent sur `cle`.
    mouvement: ({ compte, montant, motif, cle }) => appel('POST', 'mouvement', { compte, montant, motif, cle }),
  };
}
