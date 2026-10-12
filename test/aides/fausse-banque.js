// Fausse banque pour les tests : implémente en mémoire l'API interne décrite dans le contrat
// « Économie commune » (servie en vrai par le poker). Mêmes routes, mêmes codes de réponse,
// idempotence sur `cle`, 409 « Solde insuffisant », refus des requêtes passées par un proxy.
//
// Pannes simulables :
//   banque.etat.panne = true             → toute connexion est coupée (banque injoignable) ;
//   banque.etat.appliquerPuisCouper = n  → les n prochains mouvements sont appliqués, puis la
//                                          connexion est coupée avant la réponse (réponse perdue).
import http from 'node:http';
import { once } from 'node:events';

export const SOLDE_DEPART = 10_000;

export async function demarrerFausseBanque({ secret = 'secret-de-test' } = {}) {
  const comptes = new Map();
  const mouvements = new Map();
  const journal = [];
  const etat = { panne: false, appliquerPuisCouper: 0 };
  let prochainId = 1;

  function vue(compte, verse = []) {
    return {
      id: compte.id, nom: compte.nom, solde: compte.solde, sur_tables: 0,
      admin: compte.admin, actif: compte.actif, verse,
    };
  }

  function parNom(nom) {
    const cible = String(nom).trim().toLowerCase();
    return [...comptes.values()].find((compte) => compte.nom.toLowerCase() === cible);
  }

  function journaliser(compte, montant, motif, cle = null) {
    compte.solde += montant;
    journal.push({ compte: compte.id, montant, motif, cle });
  }

  function creer(nom, mdp, { solde = SOLDE_DEPART, admin = false, parrain = null } = {}) {
    const compte = { id: prochainId++, nom, mdp, solde: 0, admin, actif: true, parrain, aVerser: [] };
    comptes.set(compte.id, compte);
    journaliser(compte, solde, 'Cadeau de bienvenue');
    return compte;
  }

  // « Toucher » : verse ce qui a été programmé (allocation du jour, renflouement).
  function toucher(compte) {
    const verse = compte.aVerser.splice(0);
    for (const entry of verse) journaliser(compte, entry.montant, entry.motif);
    return verse;
  }

  const serveur = http.createServer(async (requete, reponse) => {
    if (etat.panne) {
      requete.socket.destroy();
      return;
    }
    const envoyer = (status, data) => {
      reponse.writeHead(status, { 'Content-Type': 'application/json' });
      reponse.end(JSON.stringify(data));
    };
    if (requete.headers['x-forwarded-for'] || requete.headers['x-real-ip']) return envoyer(404, { erreur: 'Introuvable' });
    if (requete.headers.authorization !== `Bearer ${secret}`) return envoyer(401, { erreur: 'Non autorisé' });

    let corps = {};
    if (requete.method === 'POST') {
      const morceaux = [];
      for await (const morceau of requete) morceaux.push(morceau);
      try {
        corps = JSON.parse(Buffer.concat(morceaux).toString('utf8') || '{}');
      } catch {
        return envoyer(400, { erreur: 'JSON invalide' });
      }
    }
    const url = new URL(requete.url, 'http://banque');
    const chemin = url.pathname.replace(/^\/interne\/banque\//, '');

    if (requete.method === 'POST' && chemin === 'connexion') {
      const compte = parNom(corps.nom ?? '');
      if (!compte || compte.mdp !== corps.mdp) return envoyer(401, { erreur: 'Identifiants incorrects' });
      if (!compte.actif) return envoyer(403, { erreur: 'Compte désactivé' });
      return envoyer(200, vue(compte, toucher(compte)));
    }

    if (requete.method === 'POST' && chemin === 'inscription') {
      const nom = typeof corps.nom === 'string' ? corps.nom.trim() : '';
      const mdp = typeof corps.mdp === 'string' ? corps.mdp : '';
      if ([...nom].length < 2 || [...nom].length > 20) return envoyer(400, { erreur: 'Le pseudo doit faire entre 2 et 20 caractères' });
      if (mdp.length < 8) return envoyer(400, { erreur: 'Le mot de passe doit faire au moins 8 caractères' });
      if (parNom(nom)) return envoyer(409, { erreur: 'Ce pseudo est déjà pris' });
      const parrain = corps.parrain ?? null;
      if (parrain !== null && !comptes.has(parrain)) return envoyer(400, { erreur: 'Parrain inconnu' });
      return envoyer(201, vue(creer(nom, mdp, { parrain })));
    }

    if (requete.method === 'GET' && chemin === 'comptes') {
      const ids = (url.searchParams.get('ids') ?? '').split(',').map(Number).filter(Number.isInteger);
      return envoyer(200, { comptes: ids.filter((id) => comptes.has(id)).map((id) => vue(comptes.get(id))) });
    }

    const parId = /^comptes\/(\d+)$/.exec(chemin);
    if (requete.method === 'GET' && parId) {
      const compte = comptes.get(Number(parId[1]));
      if (!compte) return envoyer(404, { erreur: 'Compte introuvable' });
      return envoyer(200, vue(compte, toucher(compte)));
    }

    if (requete.method === 'POST' && chemin === 'mouvement') {
      const { compte: id, montant, motif, cle } = corps;
      if (!Number.isInteger(id) || !Number.isInteger(montant) || montant === 0
        || typeof motif !== 'string' || !motif || typeof cle !== 'string' || !cle) {
        return envoyer(400, { erreur: 'Mouvement invalide' });
      }
      const compte = comptes.get(id);
      if (!compte) return envoyer(404, { erreur: 'Compte introuvable' });
      // Idempotence : la clé est vérifiée avant le solde.
      const deja = mouvements.get(cle);
      if (deja) {
        if (deja.compte !== id || deja.montant !== montant) return envoyer(409, { erreur: 'Clé déjà utilisée' });
        return envoyer(200, { solde: compte.solde, deja_fait: true });
      }
      if (compte.solde + montant < 0) return envoyer(409, { erreur: 'Solde insuffisant' });
      mouvements.set(cle, { compte: id, montant, motif });
      journaliser(compte, montant, motif, cle);
      if (etat.appliquerPuisCouper > 0) {
        etat.appliquerPuisCouper -= 1;
        requete.socket.destroy();
        return;
      }
      return envoyer(200, { solde: compte.solde, deja_fait: false });
    }

    envoyer(404, { erreur: 'Route inconnue' });
  });

  serveur.listen(0, '127.0.0.1');
  await once(serveur, 'listening');
  const { port } = serveur.address();

  return {
    url: `http://127.0.0.1:${port}`,
    secret,
    etat,
    comptes,
    mouvements,
    journal,
    creer,
    parNom,
    // Programme un versement pour le prochain « toucher » (ex. allocation du jour).
    programmerVersement(id, motif, montant) {
      comptes.get(id).aVerser.push({ motif, montant });
    },
    async fermer() {
      serveur.closeAllConnections();
      serveur.close();
      await once(serveur, 'close');
    },
  };
}
