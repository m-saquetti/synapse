// Ponte mínima entre o aplicativo e a interface: informa que a Synapse está rodando como programa e oferece
// "Reiniciar para atualizar". A interface não recebe acesso ao Node.js, ao sistema nem ao ipcRenderer:
// só a três pedidos fixos e a dois avisos, e o processo principal confere de qual janela o pedido veio.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('synapseApp', Object.freeze({
  desktop: true,
  plataforma: process.platform,
  atualizacao: Object.freeze({
    estado: () => ipcRenderer.invoke('synapse:atualizacao:estado'),
    // A confirmação leva a identidade do pacote que o usuário viu; outro pacote exige nova confirmação.
    reiniciar: (id) => ipcRenderer.invoke('synapse:atualizacao:reiniciar', String(id ?? '')),
    cancelar: () => ipcRenderer.invoke('synapse:atualizacao:cancelar'),
    aoMudar: (funcao) => {
      if (typeof funcao !== 'function') return () => {};
      const ouvinte = (_evento, estado) => funcao(estado);
      ipcRenderer.on('synapse:atualizacao', ouvinte);
      return () => ipcRenderer.removeListener('synapse:atualizacao', ouvinte);
    },
  }),
  // 1.7: aviso de entrada e saída da tela cheia (F11), só para a interface ajustar a barra de título.
  telaCheia: Object.freeze({
    aoMudar: (funcao) => {
      if (typeof funcao !== 'function') return () => {};
      const ouvinte = (_evento, cheia) => funcao(Boolean(cheia));
      ipcRenderer.on('synapse:tela-cheia', ouvinte);
      return () => ipcRenderer.removeListener('synapse:tela-cheia', ouvinte);
    },
  }),
}));
window.addEventListener('DOMContentLoaded', () => document.documentElement.classList.add('app-desktop'));
