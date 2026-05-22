Shader "Test/Comments" {
  // HLSLPROGRAM  ← 注释里假关键字
  SubShader {
    Pass {
      // following block is real
      HLSLPROGRAM
      // ENDHLSL  ← 注释里假关键字
      void f() {}
      ENDHLSL
    }
  }
}
