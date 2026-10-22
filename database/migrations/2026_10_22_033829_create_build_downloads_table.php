<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('build_downloads', function (Blueprint $table) {
            $table->id();
            $table->unsignedBigInteger('build_id');
            $table->date('date');
            $table->unsignedInteger('count')->default(0);

            $table->unique(['build_id', 'date']);
            $table->index('date');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('build_downloads');
    }
};
