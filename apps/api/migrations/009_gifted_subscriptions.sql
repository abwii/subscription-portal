-- ADR-001 #12 : un abonnement issu d'un cadeau porte le cadeau. Il est actif sur toute la durée offerte
-- (une seule période longue) avec une annulation programmée à son terme : jamais renouvelé, jamais facturé,
-- clos par le job de clôture comme n'importe quelle annulation programmée.

ALTER TABLE subscriptions ADD COLUMN gift_id uuid REFERENCES gifts (id);
