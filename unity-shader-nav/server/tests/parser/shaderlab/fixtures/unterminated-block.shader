Shader "Bad" {
  SubShader {
    Pass {
      HLSLPROGRAM
      // forgot ENDHLSL
      void vert() {}
    }
  }
}
