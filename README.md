# Enquete ao Vivo (Real-Time Polling System)

Sistema web completo inspirado no Mentimeter (Menti) para criação e condução de enquetes interativas com resultados em tempo real via internet e suporte a **perfis com pesos customizados**.

---

## 🚀 Funcionalidades Principais

1. **Painel do Apresentador (`/admin.html`)**:
   - Criação e gerenciamento de enquetes (título, descrição, status).
   - Suporte opcional a **Perfis e Dinâmica de Pesos por Alternativa**:
     - O organizador cadastra os perfis (ex: *Peixe*, *Pássaro*, *Gato*).
     - **Para cada pergunta e para cada alternativa**, o organizador pode calibrar o peso do voto de cada perfil individualmente (ex: *Peixe* votando em *Mar* tem peso 3.0, mas votando em *Terra* tem peso 1.0).
     - Nas perguntas seguintes, as regras de afinidade e pesos podem ser completamente diferentes ou mantidas equilibradas!
     - Também continua permitindo enquetes clássicas sem perfis (peso padrão 1.0 uniforme).
   - Cadastro e edição de perguntas e opções de resposta com visualização dos badges de peso.
   - Geração dinâmica de **QR Code** e **Código de Acesso alfanumérico (6 caracteres)** para compartilhamento.

2. **Tela de Apresentação / Slides (`/present.html#ID_DA_ENQUETE`)**:
   - Desenvolvida para projeção em telões/monitores em tela cheia (`F`).
   - Tela de espera com QR Code ampliado e código em destaque.
   - Navegação por slides/perguntas (← / → ou atalhos do teclado).
   - Controles de abertura e fechamento de votação em tempo real (espaço).
   - Gráfico horizontal animado de barras com transição suave via CSS/Socket.IO.
   - Alternância entre visão de **Votos Ponderados** e **Votos Brutos** (`W`).
   - Contador de participantes conectados ao vivo.

3. **Interface dos Participantes (`/index.html` e `/vote.html`)**:
   - Otimizada para smartphones (Mobile First) com botões touch-friendly de alta usabilidade.
   - Acesso rápido via leitura do QR Code ou digitando o código na landing page.
   - Seleção de perfil no primeiro acesso (quando a enquete possuir perfis habilitados; os pesos são mantidos seguros no servidor e não revelados aos participantes).
   - Votação interativa com feedback imediato.
   - Suporte a mudança de voto durante o período aberto.

4. **Desempenho & Concorrência (+200 usuários simultâneos)**:
   - Comunicação full-duplex via **WebSockets (Socket.IO)** com arquitetura orientada a salas (`poll:${pollId}`).
   - **Debounce de 100ms** na consolidação e emissão dos resultados para evitar sobrecarga de rede sob rajadas de votação.
   - Armazenamento em memória ultra-rápido (`Map` nativo do Node.js).
   - Totalmente funcional via internet (CORS configurado e URLs relativas baseadas no host de acesso).

---

## 🛠️ Tecnologias Utilizadas

- **Backend**: Node.js, Express, Socket.IO, `qrcode`, `uuid`, `cors`
- **Frontend**: HTML5, CSS3 Moderno (Custom Properties, Flexbox, Keyframe Animations), Vanilla JavaScript (ES6+), Socket.IO Client

---

## 📦 Como Instalar e Rodar

### 1. Pré-requisitos
- Node.js instalado (versão 18 ou superior).

### 2. Instalação das dependências
Execute no terminal da pasta do projeto:
```bash
npm install
```

### 3. Iniciar o servidor
```bash
npm start
```
O servidor estará acessível em: `http://localhost:3000`

---

## 🧭 Guia de Uso Rápido

1. Acesse `http://localhost:3000/admin.html` no seu navegador.
2. Clique em **"Nova Enquete"**.
3. Preencha o título e ative o botão **"Ativar perfis com pesos"** se desejar ponderação (ex: *Senior* peso 2.0, *Junior* peso 1.0). Se mantiver desativado, funcionará como enquete clássica.
4. Adicione as perguntas e opções desejadas.
5. Clique em **"Apresentar"** para abrir a tela de apresentação (`present.html`).
6. Os participantes acessam `http://localhost:3000` ou escaneiam o QR Code exibido na tela de apresentação e votam ao vivo pelo celular.
7. Os resultados refletem imediatamente no telão!

---

## 🧪 Testes Automatizados

Para rodar o teste de validação e simulação de carga (200 participantes simultâneos):
```bash
node test-e2e.js
```
