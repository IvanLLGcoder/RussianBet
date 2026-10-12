import { ArrowRight, BadgeCheck, LineChart, Wallet } from 'lucide-react';
import { Gauge, MarketIcon } from '../components/Bits';
import { Wordmark } from '../components/Logo';

// Page d'accueil des visiteurs : l'API des marchés est réservée aux membres, on montre donc un aperçu statique.
export function Landing({ onAuth }: { onAuth: (mode: 'login' | 'register') => void }) {
  const sample = [
    { title: 'Le prochain apéro tombe-t-il un vendredi ?', chance: 0.73, volume: '12,4 k cr' },
    { title: 'Qui gagne le tournoi de FIFA du mois ?', chance: 0.41, volume: '8 210 cr' },
    { title: 'Le serveur tombe-t-il avant dimanche ?', chance: 0.18, volume: '3 050 cr' },
  ];
  return (
    <main className="page landing">
      <section className="landing-hero">
        <h1>Misez sur ce que <span>pense la bande.</span></h1>
        <p><Wordmark /> transforme vos débats en marchés. Achetez l’issue à laquelle vous croyez, suivez les probabilités en direct, encaissez si vous aviez raison.</p>
        <div className="landing-actions">
          <button className="btn btn-primary btn-large" onClick={() => onAuth('register')}>J’ai une invitation <ArrowRight size={18} /></button>
          <button className="btn btn-ghost btn-large" onClick={() => onAuth('login')}>Se connecter</button>
        </div>
      </section>
      <section className="landing-preview" aria-hidden="true">
        {sample.map((market) => (
          <div className="market-card market-card-static" key={market.title}>
            <div className="market-card-head"><MarketIcon market={{ category: 'Community' }} /><h3>{market.title}</h3><Gauge probability={market.chance} /></div>
            <div className="market-card-binary">
              <span className="outcome-button outcome-yes"><span className="outcome-button-label">Oui</span><span className="outcome-button-price">{Math.round(market.chance * 100)}¢</span></span>
              <span className="outcome-button outcome-no"><span className="outcome-button-label">Non</span><span className="outcome-button-price">{100 - Math.round(market.chance * 100)}¢</span></span>
            </div>
            <footer className="market-card-foot"><span>{market.volume} Vol.</span></footer>
          </div>
        ))}
      </section>
      <section className="landing-steps">
        <div><LineChart size={22} /><strong>Des probabilités en direct</strong><p>Chaque prise fait bouger le prix. 62¢ = 62 % de chances selon la bande.</p></div>
        <div><Wallet size={22} /><strong>1 000 crédits pour démarrer</strong><p>Des crédits virtuels, sans dépôt ni retrait. Seule la gloire est réelle.</p></div>
        <div><BadgeCheck size={22} /><strong>Une cote verrouillée</strong><p>Votre cote est figée au moment de l’ordre et payée à la résolution.</p></div>
      </section>
    </main>
  );
}
