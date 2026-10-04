package com.sentrifugo.db.mapper;

import com.sentrifugo.db.dto.PmsCycleDepartmentDTO;
import com.sentrifugo.db.entity.PmsCycleDepartmentEntity;
import org.mapstruct.Builder;
import org.mapstruct.Mapper;
import org.mapstruct.Mapping;
import org.mapstruct.MappingTarget;
import org.mapstruct.NullValuePropertyMappingStrategy;
import org.mapstruct.ReportingPolicy;

import java.util.List;

@Mapper(
        componentModel = "spring",
        unmappedTargetPolicy = ReportingPolicy.IGNORE,
        nullValuePropertyMappingStrategy = NullValuePropertyMappingStrategy.IGNORE,
        // Lombok @SuperBuilder entities/DTOs: map through constructor + setters (see PmsCycleMapper).
        builder = @Builder(disableBuilder = true)
)
public interface PmsCycleDepartmentMapper {

    // Parent / referenced entities are resolved and attached by the service, never taken from the DTO.
    @Mapping(target = "cycle", ignore = true)
    PmsCycleDepartmentEntity toEntity(PmsCycleDepartmentDTO dto);

    @Mapping(source = "cycle.id", target = "cycleId")
    PmsCycleDepartmentDTO toDTO(PmsCycleDepartmentEntity entity);

    List<PmsCycleDepartmentEntity> toEntityList(List<PmsCycleDepartmentDTO> dtoList);

    List<PmsCycleDepartmentDTO> toDTOList(List<PmsCycleDepartmentEntity> entityList);

    @Mapping(target = "id", ignore = true)
    @Mapping(target = "cycle", ignore = true)
    void updateEntityFromDto(PmsCycleDepartmentDTO dto, @MappingTarget PmsCycleDepartmentEntity entity);
}
