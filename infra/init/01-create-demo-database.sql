-- Runs once, only when the PostgreSQL volume is initialized empty.
-- The demo receiver owns this separate logical database; it never shares
-- tables with the RelayCheck platform database (`relaycheck`).
CREATE DATABASE relaycheck_demo;
