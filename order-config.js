/* QR 주문 설정값 (공개돼도 되는 값만. 비밀번호·테이블 비밀 글자·서버 키는 절대 넣지 않는다)
   Firebase 콘솔 > 프로젝트 설정 > 내 앱(웹)의 값으로 REPLACE_ME 를 바꾼다. 보안은 Firestore 규칙이 맡는다.
   (11/6 daejeon-order 프로젝트 값 입력) apiKey 가 REPLACE_ME 이면 주문 보내기가 막힌다("준비 중" 안내). */
window.ORDER_FIREBASE = {
  apiKey: "AIzaSyBOLjPRnSCJbGPSgV3kfYzoEZfQSk76sSs",
  authDomain: "daejeon-order.firebaseapp.com",
  projectId: "daejeon-order",
  storageBucket: "daejeon-order.firebasestorage.app",
  messagingSenderId: "627571261784",
  appId: "1:627571261784:web:7c5d15e639b96a3c04652d"
};
/* 에뮬레이터 시험(&emu=1)은 localhost·사설 IP 에서 열었을 때만 켜진다. 운영 주소(github.io)에서는 무시된다. */
window.ORDER_EMULATOR = { projectId: "demo-daejeon-order", firestorePort: 8080, authPort: 9099 };
