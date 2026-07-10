Shader "X" {
  SubShader {
    Pass {
      HLSLPROGRAM /* real block with trailing comment */
      void f() {}
      ENDHLSL /* done */
    }
  }
}
