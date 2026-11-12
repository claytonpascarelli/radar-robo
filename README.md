# Radar — robô de coleta

Robô que, em horário agendado, verifica perfis públicos em redes sociais, resume as publicações novas com IA e grava o resultado em um banco de dados privado.

Este repositório contém apenas o código do robô. As chaves de acesso ficam nos segredos do repositório, e a lista de perfis e as publicações ficam no banco, fora daqui.

- `rodar.js`: ponto de entrada.
- `lib/`: coletores por rede, resumo por IA, relatório diário e o ciclo de execução.
- `.github/workflows/coletar.yml`: agendamento.
